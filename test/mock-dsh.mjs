/** 仅实现插件使用的 DSH 合约，不启动 DSH、模型或任意命令执行器。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, relative, dirname, isAbsolute } from 'node:path'

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
  const services = {
    llm,
    tools: { register(tool) { if (tools.has(tool.name)) throw new Error(`工具重复注册：${tool.name}`); tools.set(tool.name, tool) } },
    dshHomePath: name => join(home, name), approval: {}, webServer,
    agentPresets: {
      async mount(agentCtx, id) {
        if (id !== 'mock') throw new Error(`模拟环境只有 mock 预设，没有 ${id}`)
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
    async waterfall(name, request) {
      const list = [...(listeners.get(name) ?? [])]
      const next = index => index < list.length ? list[index](request, () => next(index + 1)) : undefined
      return next(0)
    },
    inject(names, callback) { if (names.every(name => services[name])) return callback(ctx) },
    effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') effects.push(cleanup); return cleanup },
  }
  async function event(agent, type, data = {}) {
    const raw = { type, sessionId: agent.id, seq: agent.session.events.length, data }
    agent.session.events.push(raw); save(agent)
    await ctx.emit('session/event', agent.session, raw)
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
      await event(agent, 'tool/result', { name, callId: id, error: { message: err.message } }); throw err
    }
  }
  async function run(agent, message) {
    const plan = plans.shift() ?? (autoReply ? [{ type: 'text', text: '模拟回复：已收到这条消息。' }] : [])
    await event(agent, 'turn/start')
    await event(agent, 'user/message', { message })
    let reason = { kind: 'completed' }
    try {
      for (const step of plan) {
        switch (step.type) {
          case 'text': await event(agent, 'assistant/message', { message: { content: [{ type: 'text', text: step.text }] }, usage: step.usage }); break
          case 'chunk': await event(agent, 'assistant/chunk', { chunk: { type: 'text-delta', text: step.text } }); break
          case 'tool': await invoke(agent, step.name, step.args ?? {}); break
          case 'context': await event(agent, 'request/context', { contextWindow: step.window }); break
          case 'compact': await event(agent, 'compaction/end'); break
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
    } catch (err) { logger.warn(err); reason = { kind: 'error', error: { message: err.message } } }
    finally { await event(agent, 'turn/end', { reason }) }
  }
  async function attach(id, options, saved) {
    let idle = Promise.resolve(), disposed = false
    const header = saved?.header ?? { id, meta: options.meta ?? {} }
    const scopedTools = new Map()
    const agentCtx = { ...ctx, cwd: header.meta?.cwd, get: name => name === 'tools'
      ? { register: tool => scopedTools.set(tool.name, tool) } : ctx.get(name) }
    if (options.setup) { const commit = await options.setup(agentCtx); commit?.commit?.() }
    const agent = {
      id, ctx: agentCtx, scopedTools, results: [],
      session: { id, header, events: saved?.events ?? [],
        deriveMessages() {
          return structuredClone(this.events.filter(raw => ['user/message', 'assistant/message'].includes(raw.type))
            .map(raw => ({ role: raw.type === 'user/message' ? 'user' : 'assistant', ...raw.data.message })))
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
    }
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
