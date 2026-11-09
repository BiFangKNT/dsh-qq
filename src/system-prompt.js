import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { buildChatPrompt, buildChatContext } from './prompts.js'
import { facesForPrompt } from './faces.js'
import { listOf } from './config.js'
import { factsFileFor, glossaryFileFor, loadFactsFor, loadGlossaryFor, loadGroupDigest } from './settings.js'

const digest = text => createHash('sha256').update(text).digest('hex')

export function chatSystemRules(config, meta) {
  return buildChatPrompt(config, { isGroup: meta.scope === 'group',
    isOwner: listOf(config.ownerIds).includes(String(meta.peerId)) })
}

export function createSystemPromptStore(home) {
  const dir = home ? join(home, 'system-prompts') : ''
  const memory = new Map()
  const fileOf = id => join(dir, `${digest(id)}.json`)
  return {
    get(id) {
      if (!dir) return memory.get(id) ?? null
      const file = fileOf(id)
      if (!existsSync(file)) return null
      const value = JSON.parse(readFileSync(file, 'utf8'))
      if (value.sessionId !== id || typeof value.text !== 'string' || !value.meta ||
        !Number.isInteger(value.compactSeq)) throw new Error('system 快照格式错误，拒绝覆盖')
      return value
    },
    save(value) {
      if (!dir) { memory.set(value.sessionId, structuredClone(value)); return }
      mkdirSync(dir, { recursive: true })
      const file = fileOf(value.sessionId)
      writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
    },
    list() {
      if (!dir) return [...memory.values()]
      if (!existsSync(dir)) return []
      return readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
        .map(name => {
          const value = JSON.parse(readFileSync(join(dir, name), 'utf8'))
          if (fileOf(value.sessionId) !== join(dir, name)) throw new Error('system 快照文件名错误')
          return this.get(value.sessionId)
        })
    },
  }
}

/** 保存整个已渲染的 system；动态 context 和工具注册仍交给宿主。 */
export function installChatSystem({ agentCtx, config, meta, store }) {
  const prompt = agentCtx.get('systemPrompt')
  if (!prompt?.section || !prompt?.context || !prompt?.variable) {
    throw new Error('QQ 会话需要宿主 systemPrompt 的 section/context/variable 接口')
  }
  let creationRules = chatSystemRules(config, meta)
  let scanned = 0, compactSeq = -1
  const disposers = []
  try {
    disposers.push(prompt.variable('qq_chat_rules', () => chatSystemRules(config, meta)))
    disposers.push(prompt.section({ name: 'dsh-qq:rules', order: 90, text: '{{qq_chat_rules}}' }))
    disposers.push(prompt.section({ name: 'dsh-qq:locked-system', order: 1000,
      text: '{{qq_locked_system}}', complete: true }))
    disposers.push(prompt.variable('qq_chat_context', () => {
      const isGroup = meta.scope === 'group'
      const now = new Date()
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      return buildChatContext(config, { isGroup, faces: facesForPrompt(config, 12),
        facts: loadFactsFor(meta), factsFile: factsFileFor(meta),
        glossary: isGroup ? loadGlossaryFor(meta) : '', glossaryFile: glossaryFileFor(meta),
        groupDigest: isGroup ? '' : loadGroupDigest({ workspaceRoot: String(config.workspaceRoot ?? '').trim() ||
          join(String(config.cwd ?? '').trim() || process.cwd(), '会话'), today: day, selfId: meta.selfId }),
      })
    }))
    disposers.push(prompt.context({ name: 'dsh-qq:chat', order: 100, text: '{{qq_chat_context}}' }))
    disposers.push(agentCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const agent = context.agent
      if (!agent) return assembled
      const session = agent.session
      const id = String(agent.id ?? session.id)
      const events = session.events
      for (; scanned < events.length; scanned++) {
        const event = events[scanned]
        if (event.type === 'compaction/end' && !Object.hasOwn(event.data ?? {}, 'error')) compactSeq = event.seq
      }
      const current = { ...assembled, sections: assembled.sections.filter(section => section.name !== 'dsh-qq:locked-system') }
      let snapshot = store.get(id)
      if (!snapshot) {
        // 升级/接回旧会话时沿用请求头；已有历史不因安装新版本而改变前缀。
        const header = session.requestHeader()
        const lastHeader = events.findLast(event => event.type === 'request/header')
        const compactedAfterRequest = compactSeq > (lastHeader?.seq ?? -1)
        const preserve = header && !compactedAfterRequest
        const rules = compactedAfterRequest ? assembled.variables.qq_chat_rules : creationRules
        const text = preserve ? (header.system ?? '') : renderPrompt({ ...current,
          variables: { ...assembled.variables, qq_chat_rules: rules } })
        snapshot = { sessionId: id, meta, text, rules: preserve ? null : digest(rules), compactSeq, retired: true,
          at: new Date().toISOString() }
        store.save(snapshot)
        creationRules = null
      } else if (compactSeq > snapshot.compactSeq) {
        snapshot = { ...snapshot, text: renderPrompt(current), rules: digest(assembled.variables.qq_chat_rules),
          compactSeq, at: new Date().toISOString() }
        store.save(snapshot)
      }
      return { ...assembled, sections: [{ name: 'dsh-qq:locked-system', text: '{{qq_locked_system}}' }],
        variables: { ...assembled.variables, qq_locked_system: snapshot.text } }
    }, { prepend: true }))
  } catch (err) {
    for (const dispose of disposers.reverse()) dispose()
    throw err
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

export function pendingSystemPrompts(store, config, selfId = '') {
  return store.list().filter(item => !item.retired && (!selfId || item.meta.selfId === selfId))
    .filter(item => item.rules !== digest(chatSystemRules(config, item.meta)))
    .map(item => ({ sessionId: item.sessionId, label: item.meta.label, scope: item.meta.scope,
      peerId: item.meta.peerId, selfId: item.meta.selfId, version: digest(chatSystemRules(config, item.meta)) }))
}
