/** 仅实现插件使用的 DSH 合约，不启动 DSH、模型或任意命令执行器。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, relative, dirname, isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt, renderPrompt, renderContextSnapshot, renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'

/** 使用真实 systemPrompt 注册/组装器，其余宿主能力仍由模拟器提供。 */
export function createMockPromptScope(base, cwd, scopedTools = new Map()) {
  const promptCtx = new Context()
  const prompt = new SystemPrompt(promptCtx, {})
  const scope = { ...base, cwd,
    get: name => name === 'systemPrompt' ? prompt : name === 'tools'
      ? { register: tool => scopedTools.set(tool.name, tool) } : base.get?.(name),
    on: (name, fn, options) => name.startsWith('system-prompt/')
      ? promptCtx.on(name, fn, options) : base.on(name, (payload, next) =>
        name.startsWith('agent/') && payload.agent?.ctx !== scope ? next?.() : fn(payload, next), options),
  }
  return scope
}

export const textOf = message => (message?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('')
export async function waitFor(predicate, { timeout = 5000, what = '条件' } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${what}`)
}

export function createMockDsh({ home, webServer, autoReply = true, verbose = false, llm } = {}) {
  if (!home) throw new Error('mock DSH 必须指定隔离的 home')
  const listeners = new Map(), tools = new Map(), live = new Map(), plans = [], effects = [], logs = []
  let closed = false, callId = 0
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const sessionFile = id => join(home, 'sessions', `${encodeURIComponent(id)}.json`)
  const save = agent => writeFileSync(sessionFile(agent.id), JSON.stringify({ header: agent.session.header,
    events: agent.session.events, received: agent.received, injected: agent.injected }))
  const logger = Object.fromEntries(['info', 'debug', 'warn', 'error'].map(level => [level, (...args) => {
    const entry = { level, text: args.map(a => a?.message ?? String(a)).join(' ') }; logs.push(entry)
    if (verbose) console.error(`[mock-dsh:${level}]`, entry.text)
  }]))
  const presetBindings = new WeakMap()
  const services = {
    llm,
    sessionProjections: {
      async register(definition) {
        return { readerFor: session => () => session.events.reduce((state, event) => definition.apply(state, event), definition.init(session.header)),
          async dispose() {} }
      },
    },
    tools: { register(tool) { if (tools.has(tool.name)) throw new Error(`工具重复注册：${tool.name}`); tools.set(tool.name, tool) } },
    dshHomePath: name => join(home, name), approval: {}, webServer,
    agentPresets: {
      defaultId: 'mock',
      async resolve(id = this.defaultId) {
        if (id !== 'mock') throw new Error(`模拟环境只有 mock 预设，没有 ${id}`)
        return { id }
      },
      composedPreset(agentCtx) { return presetBindings.get(agentCtx) },
      presetForSession(session) {
        return session.events.findLast(event => event.type === 'agent-preset/selected')?.data.agentPreset
          ?? session.header.agentPreset ?? session.header.meta?.agentPreset ?? null
      },
      async mount(agentCtx, id = this.defaultId) {
        await this.resolve(id)
        if (presetBindings.get(agentCtx) === id) return { id }
        const safePath = path => {
          const cwd = agentCtx.cwd
          if (!cwd) throw new Error('预设文件工具需要会话 cwd')
          const full = resolve(cwd, String(path))
          const rel = relative(cwd, full)
          if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || resolve(cwd, rel) !== full) throw new Error('路径超出会话工作目录')
          return full
        }
        const scoped = agentCtx.get('tools')
        scoped.register({ name: 'read', execute: async args => ({ text: await readFile(safePath(args.path ?? args.file_path), 'utf8') }) })
        scoped.register({ name: 'write', execute: async args => {
          const file = safePath(args.path ?? args.file_path); await mkdir(dirname(file), { recursive: true })
          await writeFile(file, String(args.content ?? ''), 'utf8'); return { ok: true }
        } })
        scoped.register({ name: 'edit', execute: async args => {
          const file = safePath(args.path ?? args.file_path), content = await readFile(file, 'utf8')
          if (!args.old_text || !content.includes(args.old_text)) throw new Error('没有匹配到 old_text')
          await writeFile(file, content.replace(args.old_text, String(args.new_text ?? '')), 'utf8'); return { ok: true }
        } })
        scoped.register({ name: 'read_image', execute: async args => {
          const data = await readFile(safePath(args.path ?? args.file_path))
          return { simulated: true, bytes: data.length, header: data.subarray(0, 12).toString('hex'), note: '仅验证图片可读取，不模拟视觉识别' }
        } })
        presetBindings.set(agentCtx, id)
        return { id }
      },
    },
  }
  const ctx = {
    logger, webServer,
    get: name => services[name],
    on(name, fn, options = {}) {
      const list = listeners.get(name) ?? []
      options.prepend ? list.unshift(fn) : list.push(fn); listeners.set(name, list)
      return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1) }
    },
    async emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) await fn(...args) },
    async waterfall(name, request, fallback = () => undefined) {
      const list = [...(listeners.get(name) ?? [])]
      const next = index => index < list.length ? list[index](request, () => next(index + 1)) : fallback()
      return next(0)
    },
    inject(names, callback) { if (names.every(name => services[name])) return callback(ctx) },
    effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') effects.push(cleanup); return cleanup },
  }
  function appendEvent(agent, type, data = {}, surface = {}) {
    const raw = { type, sessionId: agent.id, seq: agent.session.events.length, data, ...surface }
    agent.session.events.push(raw); save(agent)
    return raw
  }
  async function event(agent, type, data = {}, surface = {}) {
    const raw = appendEvent(agent, type, data, surface)
    await ctx.emit('session/event', agent.session, raw)
    return raw
  }
  async function invoke(agent, name, args) {
    const tool = agent.scopedTools.get(name) ?? tools.get(name)
    if (!tool) throw new Error(`工具未注册：${name}`)
    const id = `mock-call-${++callId}`
    await event(agent, 'tool/call', { name, callId: id, arguments: JSON.stringify(args) })
    try {
      const result = await tool.execute(args, { agent })
      agent.results.push({ name, result })
      await event(agent, 'tool/result', { name, callId: id, result })
      return result
    } catch (err) {
      await event(agent, 'tool/result', { name, callId: id, error: { message: err.message, code: err.code } }); throw err
    }
  }
  async function run(agent, message) {
    const plan = plans.shift() ?? (autoReply ? [{ type: 'text', text: '模拟回复：已收到这条消息。' }] : [])
    await event(agent, 'turn/start')
    await event(agent, 'user/message', message, { surfaceOp: 'append' })
    let reason = { kind: 'completed' }
    try {
      await request(agent)
      for (const step of plan) {
        switch (step.type) {
          case 'text': {
            const landed = await event(agent, 'assistant/message', { message: { content: [{ type: 'text', text: step.text }] }, usage: step.usage }, { surfaceOp: 'append' })
            await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: landed.seq } } })
            break
          }
          case 'chunk': await event(agent, 'assistant/chunk', { chunk: { type: 'text-delta', text: step.text } }); break
          case 'tool':
            await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } } })
            await invoke(agent, step.name, step.args ?? {}); await request(agent); break
          case 'context': await event(agent, 'request/context', { contextWindow: step.window }); break
          case 'compact': await event(agent, 'compaction/end'); await request(agent); break
          case 'error': reason = { kind: 'error', error: { message: step.message } }; return
          case 'question': {
            const result = await ctx.waterfall('user-questions/request', { agent, questions: step.questions })
            agent.results.push({ name: 'question', result }); break
          }
          case 'approval': {
            const id = `mock-call-${++callId}`
            await event(agent, 'tool/call', { name: 'mock_command', callId: id, arguments: JSON.stringify({ command: step.command ?? '模拟操作' }) })
            const result = await ctx.waterfall('approval/request', { agent, callId: id })
            agent.results.push({ name: 'approval', result }); break
          }
          default: throw new Error(`未知模拟步骤：${step.type}`)
        }
      }
    } catch (err) { logger.warn(err); reason = { kind: 'error', error: { message: err.message, code: err.code } } }
    finally { await event(agent, 'turn/end', { reason }); await ctx.emit('agent/status', { agent, status: 'idle' }) }
  }
  async function request(agent) {
    const assembly = await agent.ctx.get('systemPrompt').assemble(assembleContextFor(agent))
    await ctx.waterfall('agent/pre-step', { agent }, () => ({ kind: 'enter', messages: [] }))
    const prompt = agent.ctx.get('systemPrompt')
    const current = prompt.refreshContext(assembly, assembleContextFor(agent))
    const header = { system: renderPrompt(assembly), tools: assembly.tools }
    const nodes = agent.session.surface.nodes
    const systemSeq = nodes.find(seq => agent.session.events[seq].type === 'system/message')
    if (systemSeq === undefined || textOf(agent.session.events[systemSeq].data.message) !== header.system) {
      await event(agent, 'system/message', { turn: 0, step: 0, message: createSystemMessage(header.system) },
        systemSeq === undefined ? { surfaceOp: 'append' } : { surfaceOp: { op: 'replace', startSeq: systemSeq, endSeq: systemSeq }, sourceEventSeqs: [systemSeq] })
    }
    const sections = renderContextSections(current)
    if (sections.length) await event(agent, 'user/message', createUserMessage({ content: [{ type: 'text', text: renderContextSnapshot(current) }],
      source: { kind: 'runtime-context', form: 'snapshot', sections } }), { surfaceOp: 'append' })
    agent.requests.push({ ...header, context: renderContextSnapshot(current), messages: agent.session.deriveMessages() })
    await event(agent, 'request/header', { header: { config: {}, tools: assembly.tools } })
  }
  services.compaction = {
    compactNow(agent, signal) {
      return agent.runMaintenance(async () => {
        signal.throwIfAborted()
        const shadowed = agent.session.surface.nodes.filter(seq => agent.session.events[seq].type !== 'system/message')
        if (!shadowed.length) return null
        await event(agent, 'compaction/start')
        await event(agent, 'user/message', { content: [{ type: 'text', text: '模拟压缩摘要' }], source: { kind: 'compact-checkpoint' } },
          { surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed.at(-1) }, sourceEventSeqs: shadowed })
        await event(agent, 'compaction/end')
        return { endSeq: agent.session.events.length - 1 }
      })
    },
  }
  async function attach(id, options, saved) {
    let idle = Promise.resolve(), disposed = false, maintenance = false
    const header = saved?.header ?? { id, meta: options.meta ?? {} }
    const scopedTools = new Map()
    const agentCtx = createMockPromptScope(ctx, header.meta?.cwd, scopedTools)
    const agent = {
      id, ctx: agentCtx, scopedTools, results: [], requests: [],
      session: { id, header, events: saved?.events ?? [],
        snapshotEvents() { return [...this.events] },
        get seq() { return this.events.length },
        get surface() {
          const nodes = []
          for (const event of this.events) {
            if (event.surfaceOp?.op === 'replace') {
              const start = nodes.indexOf(event.surfaceOp.startSeq), end = nodes.indexOf(event.surfaceOp.endSeq)
              if (start >= 0) nodes.splice(start, end - start + 1, event.seq)
            } else if (['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'].includes(event.type)) nodes.push(event.seq)
          }
          return { nodes }
        },
        append(type, data, surface) { return appendEvent(agent, type, data, surface) },
        requestHeader() { return this.events.findLast(raw => raw.type === 'request/header')?.data.header },
        deriveMessages() {
          return structuredClone(this.surface.nodes.map(seq => this.events[seq]).filter(raw =>
            ['system/message', 'developer/message', 'user/message', 'assistant/message'].includes(raw.type))
            .map(raw => ({ role: raw.type.split('/')[0], ...(raw.data.message ?? raw.data) }))
            .filter(message => message.content?.length))
        },
      },
      received: saved?.received ?? [], injected: saved?.injected ?? [],
      followup(message) {
        if (closed || disposed) throw new Error('Agent 已释放')
        if (!Array.isArray(message?.content)) throw new Error('followup 需要完整消息对象')
        this.received.push(message); save(this)
        idle = idle.then(() => run(this, message)); return undefined
      },
      inject(message) { this.injected.push(message); save(this) },
      whenIdle: () => idle,
      runMaintenance(task) {
        if (maintenance) throw new Error('Agent 正在维护')
        maintenance = true
        const run = Promise.resolve().then(task).finally(() => { maintenance = false })
        idle = run.catch(() => {})
        return run
      },
    }
    if (options.setup) { const commit = await options.setup(agentCtx, agent); commit?.commit?.() }
    live.set(id, agent); save(agent)
    return { agent, async dispose() { disposed = true; live.delete(id) } }
  }
  services.agents = ctx.agents = {
    get: id => live.get(id),
    async create(options) {
      const id = options.sessionId
      if (live.has(id) || existsSync(sessionFile(id))) throw new Error(`会话已经存在：${id}`)
      return attach(id, options)
    },
    async resume(options) {
      const id = options.resumeSessionId
      if (live.has(id)) throw new Error('会话已被加载')
      const saved = JSON.parse(readFileSync(sessionFile(id), 'utf8'))
      return attach(id, options, saved)
    },
  }
  return {
    ctx, tools, logs, agents: live,
    queueTurn(plan) {
      if (!Array.isArray(plan)) throw new Error('plan 必须是步骤数组')
      plans.push(plan)
    },
    emitEvent(id, type, data) { const agent = live.get(id); if (!agent) throw new Error('会话不存在'); return event(agent, type, data) },
    async dispose() {
      closed = true
      await ctx.emit('dispose')
      for (const cleanup of effects.reverse()) await cleanup()
      listeners.clear(); tools.clear(); live.clear()
    },
  }
}
