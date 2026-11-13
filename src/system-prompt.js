import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { buildChatPrompt } from './prompts.js'
import { installRuntimeContext } from './runtime-context.js'
import { prepareSessionView } from './session-view.js'

const digest = text => createHash('sha256').update(text).digest('hex')

export function chatSystemRules(config, meta) {
  return buildChatPrompt(config, { isGroup: meta.scope === 'group' })
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
const installations = new WeakMap()

export async function installChatSystem({ agentCtx, agent, config, meta, store, runtimeContext = null }) {
  if (installations.has(agent)) return installations.get(agent)
  const pending = install({ agentCtx, agent, config, meta, store, runtimeContext })
  installations.set(agent, pending)
  pending.catch(() => installations.delete(agent))
  return pending
}

async function install({ agentCtx, agent, config, meta, store, runtimeContext }) {
  const view = await prepareSessionView(agentCtx, agent, config)
  const prompt = agentCtx.get('systemPrompt')
  if (!prompt?.section || !prompt?.context || !prompt?.variable) {
    throw new Error('QQ 会话需要宿主 systemPrompt 的 section/context/variable 接口')
  }
  let creationRules = chatSystemRules(config, meta)
  const disposers = []
  try {
    disposers.push(prompt.variable('qq_chat_rules', () => chatSystemRules(config, meta)))
    disposers.push(prompt.section({ name: 'dsh-qq:rules', order: 90, text: '{{qq_chat_rules}}' }))
    disposers.push(prompt.section({ name: 'dsh-qq:locked-system', order: 1000,
      text: '{{qq_locked_system}}', complete: true }))
    if (runtimeContext) disposers.push(installRuntimeContext(agentCtx, agent, runtimeContext, view))
    disposers.push(agentCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const agent = context.agent
      if (!agent) return assembled
      const session = agent.session
      const id = String(agent.id ?? session.id)
      const { compactSeq, lastHeaderSeq, systems } = view()
      const current = { ...assembled, sections: assembled.sections.filter(section => section.name !== 'dsh-qq:locked-system') }
      let snapshot = store.get(id)
      if (!snapshot) {
        // 新版 system 是消息节点；空 system 也是已锁定的有效值。
        const compactedAfterRequest = compactSeq > lastHeaderSeq
        const preserve = systems.length > 0 && !compactedAfterRequest
        const rules = compactedAfterRequest ? assembled.variables.qq_chat_rules : creationRules
        const text = preserve ? (systems.findLast(node => node.text !== '')?.text ?? '') : renderPrompt({ ...current,
          variables: { ...assembled.variables, qq_chat_rules: rules } })
        snapshot = { sessionId: id, meta, text, rules: preserve ? null : digest(rules), compactSeq, retired: true,
          at: new Date().toISOString() }
        store.save(snapshot)
        creationRules = null
      } else if (context.qqForceSystemSync === true || compactSeq > snapshot.compactSeq) {
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
  let disposed = false
  return () => {
    if (disposed) return
    for (const dispose of disposers.toReversed()) dispose()
    disposed = true
    installations.delete(agent)
  }
}

export function pendingSystemPrompts(store, config, selfId = '') {
  return store.list().filter(item => !item.retired && (!selfId || item.meta.selfId === selfId))
    .filter(item => item.rules !== digest(chatSystemRules(config, item.meta)))
    .map(item => ({ sessionId: item.sessionId, label: item.meta.label, scope: item.meta.scope,
      peerId: item.meta.peerId, selfId: item.meta.selfId, version: digest(chatSystemRules(config, item.meta)) }))
}
