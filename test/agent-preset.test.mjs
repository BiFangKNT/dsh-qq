import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SessionManager } from '../src/session.js'
import { sanitizeOverrides } from '../src/settings.js'
import { deriveSessionId, sessionKey } from '../src/shared/session-id.js'

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-preset-registry'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const [{ Context }, { default: Loader }, { default: AgentRegistry }, llm, sessions,
  { default: Projections }, { default: SystemPrompt }, { default: Tools }, { default: Presets }] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/cordis-plugin-loader'), load('@deepseek-ai/dsh-agent'),
  load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-session-projection'),
  load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-agent-preset-registry'),
])
const { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop')
const Persistence = await import('@deepseek-ai/dsh-session-persistence-jsonl')
const Native = await import('@deepseek-ai/dsh-tool-executor-native')
const logger = { info() {}, warn() {}, debug() {} }
const peer = { scope: 'private', peerId: '11001', label: '测试私聊' }

async function harness(t, { preset = '', persisted = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qq-presets-'))
  const ctx = new Context(), requests = [], managers = [], handles = []
  const diagnostics = []
  ctx.logger.exporter({ export: entry => diagnostics.push(entry.args.map(String).join(' ')) })
  t.after(async () => {
    for (const manager of managers) manager.stop()
    for (const handle of handles) await handle.dispose()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const toolModule = join(root, 'image-tool.mjs')
  const fixtures = import.meta.resolve('@deepseek-ai/dsh-tool-testkit')
  await writeFile(toolModule, `import { defineContentToolFixture } from ${JSON.stringify(fixtures)}
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register(defineContentToolFixture({ name: 'read_image', description: 'Test image tool', parameters: {},
    execute: async () => [{ type: 'text', text: 'image opened' }] }))
}
`)
  for (const plugin of [Loader, llm.default, sessions.default, Projections, SystemPrompt, Tools, Native, AgentRegistry]) await ctx.plugin(plugin)
  if (persisted) await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Presets, { default: 'images' })
  class Adapter extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new Adapter())
  const register = async (id, image = true) => {
    const dispose = await ctx.agentPresets.register({ id,
      plugins: image ? [{ id: 'image-tool', name: pathToFileURL(toolModule).href }] : [] })
    ctx.effect(() => dispose)
    assert.equal((await ctx.agentPresets.resolve(id)).broken, undefined, diagnostics.join('\n'))
    return dispose
  }
  await register('images')
  const config = { preset, isolateByPeer: false, provider: 'mock', model: 'mock' }
  const manager = () => {
    const item = new SessionManager({ ctx, agents: ctx.agents, selfId: '10001', config, logger, home: join(root, 'qq') })
    managers.push(item)
    return item
  }
  const send = async agent => {
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: '看图' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    return requests.at(-1)
  }
  return { ctx, root, config, requests, manager, register, send, handles }
}

test('真实预设服务：preset 留空也加载默认预设，read_image 进入模型工具列表', async t => {
  const h = await harness(t), record = await h.manager().obtain(peer)
  assert.equal(h.ctx.agentPresets.composedPreset(record.agent.ctx), 'images')
  assert.equal(h.ctx.agentPresets.presetForSession(record.agent.session), 'images')
  assert.equal(record.agent.session.header.agentPreset, 'images')
  assert.equal((await h.send(record.agent)).tools.filter(tool => tool.name === 'read_image').length, 1)
})

test('真实预设服务：显式预设优先于默认，设置覆盖保留 preset', async t => {
  const h = await harness(t, { preset: 'explicit' })
  await h.register('explicit')
  await h.register('empty', false)
  h.ctx.agentPresets.config.default = 'empty'
  const record = await h.manager().obtain(peer)
  assert.equal(record.agent.session.header.agentPreset, 'explicit')
  assert.equal((await h.send(record.agent)).tools.filter(tool => tool.name === 'read_image').length, 1)
  assert.deepEqual(sanitizeOverrides({ preset: 'explicit' }), { preset: 'explicit' })
})

test('真实预设服务：复用已挂载 Agent 不因默认值或配置变化切换预设', async t => {
  const h = await harness(t), manager = h.manager(), record = await manager.obtain(peer)
  await h.register('empty', false)
  h.ctx.agentPresets.config.default = 'empty'
  h.config.preset = 'empty'
  let mounts = 0
  const originalMount = h.ctx.agentPresets.mount.bind(h.ctx.agentPresets)
  h.ctx.agentPresets.mount = async (...args) => { mounts++; return originalMount(...args) }
  const reused = await h.manager().obtain(peer)
  assert.equal(reused.agent, record.agent)
  assert.equal(reused.owned, false)
  assert.equal(mounts, 0)
  assert.equal((await h.send(reused.agent)).tools.filter(tool => tool.name === 'read_image').length, 1)
})

test('真实预设服务：恢复时保留已保存的预设，不改用新的默认值', async t => {
  const h = await harness(t, { persisted: true }), manager = h.manager(), record = await manager.obtain(peer)
  await h.send(record.agent)
  manager.stop()
  await record.dispose()
  await h.register('empty', false)
  h.ctx.agentPresets.config.default = 'empty'
  h.config.preset = 'empty'
  const restored = await h.manager().obtain(peer)
  assert.equal(restored.sessionId, record.sessionId)
  assert.equal(h.ctx.agentPresets.composedPreset(restored.agent.ctx), 'images')
  assert.equal((await h.send(restored.agent)).tools.filter(tool => tool.name === 'read_image').length, 1)
})

test('真实预设服务：旧的运行中 Agent 等空闲后补挂，记录选择且不重复挂载', async t => {
  const h = await harness(t, { persisted: true })
  const id = deriveSessionId(sessionKey('10001', peer.scope, peer.peerId))
  const handle = await h.ctx.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
  h.handles.push(handle)
  await h.send(handle.agent)
  const messages = handle.agent.session.deriveMessages()
  const originalWhenIdle = handle.agent.whenIdle.bind(handle.agent)
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  handle.agent.whenIdle = async () => { entered.resolve(); await gate.promise; await originalWhenIdle() }
  const obtaining = h.manager().obtain(peer)
  await entered.promise
  assert.equal(h.ctx.agentPresets.composedPreset(handle.agent.ctx), undefined)
  gate.resolve()
  const record = await obtaining
  handle.agent.whenIdle = originalWhenIdle
  assert.equal(record.agent, handle.agent)
  assert.equal(h.ctx.agentPresets.composedPreset(record.agent.ctx), 'images')
  assert.equal(h.ctx.agentPresets.presetForSession(record.agent.session), 'images')
  assert.equal(record.agent.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected').length, 1)
  assert.deepEqual(record.agent.session.deriveMessages(), messages)
  assert.equal((await h.send(record.agent)).tools.filter(tool => tool.name === 'read_image').length, 1)
  await h.manager().obtain(peer)
  assert.equal(record.agent.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected').length, 1)

  await handle.dispose()
  await h.register('empty', false)
  h.ctx.agentPresets.config.default = 'empty'
  const restored = await h.manager().obtain(peer)
  assert.equal(h.ctx.agentPresets.composedPreset(restored.agent.ctx), 'images')
})

test('真实预设服务：恢复使用最新的选择记录，不只读取创建时的 header', async t => {
  const h = await harness(t, { persisted: true })
  await h.register('empty', false)
  const manager = h.manager(), record = await manager.obtain(peer)
  assert.equal(record.agent.session.header.agentPreset, 'images')
  await h.ctx.agentPresets.select(record.agent, 'empty')
  await h.send(record.agent)
  manager.stop()
  await record.dispose()
  const restored = await h.manager().obtain(peer)
  assert.equal(h.ctx.agentPresets.composedPreset(restored.agent.ctx), 'empty')
  assert.equal((await h.send(restored.agent)).tools, undefined)
})

test('真实预设服务：预设不存在或挂载失败时不换壳创建无工具会话', async t => {
  const h = await harness(t, { preset: 'missing' })
  const manager = h.manager()
  await assert.rejects(manager.obtain(peer), /Unknown agent preset/)
  assert.equal(manager.size, 0)
  await h.ctx.agentPresets.register({ id: 'broken', plugins: [{ id: 'invalid', name: 'nonexistent-fixture-plugin' }] })
  h.config.preset = 'broken'
  await assert.rejects(manager.obtain(peer), /never started/)
  assert.equal(manager.size, 0)
  assert.equal(h.requests.length, 0)
})

test('真实预设服务：历史预设被移除后明确失败，不改用配置里的其他预设', async t => {
  const h = await harness(t, { persisted: true, preset: 'removed' })
  const remove = await h.register('removed')
  const manager = h.manager(), record = await manager.obtain(peer)
  await h.send(record.agent)
  manager.stop()
  await record.dispose()
  await remove()
  h.config.preset = 'images'
  const restoredManager = h.manager()
  await assert.rejects(restoredManager.obtain(peer), /Unknown agent preset: removed/)
  assert.equal(restoredManager.size, 0)
  assert.equal(h.ctx.agents.get(record.sessionId), undefined)
})
