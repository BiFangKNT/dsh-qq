import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installChatSystem, createSystemPromptStore } from '../src/system-prompt.js'
import { clearRuntimeContext } from '../src/runtime-context.js'
import { runtimeContextName } from '../src/session-view.js'
import { assertHostAccepted } from '../src/host-compatibility.js'
import { SILENT_HINT } from '../src/prompts.js'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const [{ Context }, { default: AgentRegistry }, llm, sessionApi, { default: SystemPrompt }, tools,
  { default: AgentLoop }, { default: Projections }] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session'),
  load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-agent-loop'), load('@deepseek-ai/dsh-session-projection'),
])
const Native = await import('@deepseek-ai/dsh-tool-executor-native')
const { defineContentToolFixture } = await import('@deepseek-ai/dsh-tool-testkit')
const { default: TokenMeter } = await import('@deepseek-ai/dsh-token-meter')
const { default: Compaction } = await import('@deepseek-ai/dsh-compaction-basic')
const Persistence = await import('@deepseek-ai/dsh-session-persistence-jsonl')
const textResponse = text => [
  { type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } },
]
const toolResponse = [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: llm.ToolCallId('change-1'), name: 'change_state', argumentsDelta: '{}' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: llm.ToolCallId('change-1'), name: 'change_state', arguments: '{}' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const hasState = message => message.source?.kind === 'runtime-context' &&
  message.source.sections?.some(section => section.name === runtimeContextName)
const text = value => JSON.stringify(value)

async function harness(t, { root, respond, compact = false } = {}) {
  const ctx = new Context(), requests = [], errors = [], handles = []
  for (const plugin of [llm.default, sessionApi.default, Projections, SystemPrompt, tools.default, Native, AgentRegistry, TokenMeter]) await ctx.plugin(plugin)
  if (root) await ctx.plugin(Persistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (compact) await ctx.plugin(Compaction, { headroomTokens: 0, maxTokens: 128, retainTokens: 0,
    ...(typeof compact === 'object' ? compact : {}) })
  class Adapter extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 1000000 } } }
    async *stream(options) {
      requests.push(options)
      if (options.purpose === 'compaction') yield* textResponse('conversation summary')
      else if (respond) yield* respond(options, requests)
      else yield* textResponse('ok')
    }
  }
  ctx.llm.registerAdapter(['mock'], new Adapter())
  ctx.on('agent/error', ({ error }) => errors.push(error))
  const store = createSystemPromptStore(''), config = { persona: '固定人设', ownerIds: [] }
  let state = 'STATE-V1', renderCount = 0
  const setup = async (agentCtx, agent) => {
    await installChatSystem({ agentCtx, agent, config, store,
      meta: { selfId: '10001', scope: 'private', peerId: '11001' },
      runtimeContext: () => { renderCount++; return state } })
  }
  async function attach(id = 'qq-native', resume = false, managed = true) {
    const options = { agentOptions: { provider: 'mock', model: 'mock' }, ...(managed ? { setup } : {}) }
    const handle = resume ? await ctx.agents.resume({ resumeSessionId: sessionApi.SessionId(id), ...options })
      : await ctx.agents.create({ sessionId: sessionApi.SessionId(id), ...options })
    handles.push(handle)
    return handle
  }
  async function send(agent, body = 'hello', source = { kind: 'user' }) {
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: body }], source }))
    await agent.whenIdle()
    assert.deepEqual(errors, [])
  }
  t.after(async () => { for (const handle of handles.toReversed()) await handle.dispose(); await ctx.fiber.dispose() })
  return { ctx, requests, errors, attach, send, setup, config, store, get renderCount() { return renderCount }, set state(value) { state = value } }
}

test('未修改的 rc.2：最新状态、重复安装与清理幂等、普通 agent 隔离', async t => {
  const h = await harness(t), { agent } = await h.attach()
  let otherState = 'OTHER-V1'
  agent.ctx.get('systemPrompt').context({ name: 'other-plugin', order: 50, text: () => otherState })
  await h.setup(agent.ctx, agent)
  await h.setup(agent.ctx, agent)
  await h.send(agent)
  assert.equal(h.renderCount, 1)
  assert.equal(h.requests[0].messages.filter(hasState).length, 1)
  assert.equal(hasState(h.requests[0].messages.at(-1)), true)
  assert.match(text(h.requests[0].messages.at(-1)), /OTHER-V1/)
  assert.doesNotMatch(text(agent.session.deriveMessages()), /STATE-/)
  const seq = agent.session.seq
  clearRuntimeContext(agent); clearRuntimeContext(agent)
  assert.equal(agent.session.seq, seq)
  h.config.persona = '尚未同步的人设'
  h.state = 'STATE-V2'
  otherState = 'OTHER-V2'
  await h.send(agent)
  assert.equal(h.renderCount, 2)
  assert.match(text(h.requests[1].messages.at(-1)), /STATE-V2/)
  assert.doesNotMatch(text(h.requests[1]), /STATE-V1|尚未同步的人设/)
  assert.match(text(h.requests[1].messages.at(-1)), /OTHER-V2/)
  assert.doesNotMatch(text(h.requests[1]), /OTHER-V1/)
  assert.match(text(agent.session.snapshotEvents()), /STATE-V1/)
  const ordinary = await h.attach('ordinary', false, false)
  ordinary.agent.ctx.get('systemPrompt').context({ name: 'ordinary-context', order: 50, text: 'ORDINARY-STATE' })
  await h.send(ordinary.agent)
  assert.equal(h.requests.at(-1).messages.some(hasState), false)
  assert.match(text(ordinary.agent.session.deriveMessages()), /ORDINARY-STATE/)
  assert.throws(() => assertHostAccepted({}, { '@deepseek-ai/dsh-agent-loop': '0.2.3' }), /未经验证/)
})

test('工具续调刷新、网络重试复用快照，清理不改写已发送请求', async t => {
  let call = 0
  const h = await harness(t, { respond: function* () {
    if (call++ === 0) { h.state = 'STATE-CHANGED-DURING-RETRY'; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER_ERROR', message: 'retry' } } } }
    else if (call === 2) yield* toolResponse
    else yield* textResponse('ok')
  } })
  const { agent } = await h.attach()
  h.ctx.tools.register(defineContentToolFixture({ name: 'change_state', description: 'change state', parameters: {}, async execute() {
    assert.doesNotMatch(text(agent.session.deriveMessages()), /STATE-/)
    h.state = 'STATE-AFTER-TOOL'
    return [{ type: 'text', text: 'tool result' }]
  } }))
  let retries = 0
  agent.ctx.on('agent/request-error', async (_payload, next) => retries++ === 0 ? { kind: 'retry' } : next())
  await h.send(agent, '普通群消息', { kind: 'user', qqMaySilent: true })
  assert.equal(h.requests.length, 3)
  assert.equal(h.renderCount, 2)
  assert.deepEqual(h.requests[0].messages, h.requests[1].messages)
  assert.match(text(h.requests[0]), /STATE-V1/)
  assert.doesNotMatch(text(h.requests[1]), /STATE-CHANGED-DURING-RETRY/)
  assert.match(text(h.requests[2].messages.at(-1)), /STATE-AFTER-TOOL/)
  assert.equal(h.requests[2].messages.at(-2).role, 'tool')
  assert.doesNotMatch(text(agent.session.deriveMessages()), /STATE-/)
  for (const request of h.requests) {
    const content = request.messages.at(-1).content.map(block => block.text ?? '').join('')
    assert.ok(content.includes(SILENT_HINT))
    assert.equal(request.messages.filter(message => text(message).includes(SILENT_HINT)).length, 1)
  }
  assert.equal(text(agent.session.deriveMessages()).includes(SILENT_HINT), false)
})

test('沉默说明只在本轮末尾出现，不留历史、不进压缩，也不沿用到主动机会和下次点名', async t => {
  const h = await harness(t, { compact: true }), { agent } = await h.attach()
  await h.send(agent, '普通群消息 '.repeat(500), { kind: 'user', qqMaySilent: true })
  assert.ok(text(h.requests.at(-1).messages.at(-1)).includes(SILENT_HINT))
  assert.equal(text(agent.session.deriveMessages()).includes(SILENT_HINT), false)
  const system = h.requests[0].messages[0]
  assert.ok(await h.ctx.compaction.compactNow(agent, new AbortController().signal))
  assert.equal(h.requests.at(-1).purpose, 'compaction')
  assert.equal(text(h.requests.at(-1)).includes(SILENT_HINT), false)
  await h.send(agent, '明确点名', { kind: 'user', qqMaySilent: false })
  assert.equal(text(h.requests.at(-1)).includes(SILENT_HINT), false)
  await h.send(agent, '又一条普通消息', { kind: 'user', qqMaySilent: true })
  assert.ok(text(h.requests.at(-1).messages.at(-1)).includes(SILENT_HINT))
  await h.send(agent, '主动机会', { kind: 'plugin', plugin: 'dsh-qq', form: 'proactive' })
  assert.equal(text(h.requests.at(-1)).includes(SILENT_HINT), false)
  assert.deepEqual(h.requests.at(-1).messages[0].content, system.content)
})

test('真实手动与超窗 compact 不含状态，压缩后更新锁定 system 并恢复状态', async t => {
  let overflow = false
  const h = await harness(t, { compact: true, respond: function* () {
    if (overflow) { overflow = false; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'overflow' } } } }
    else yield* textResponse('ok')
  } })
  const { agent } = await h.attach()
  await h.send(agent, 'conversation '.repeat(500))
  h.config.persona = '压缩后新设定'
  assert.ok(await h.ctx.compaction.compactNow(agent, new AbortController().signal))
  assert.equal(h.requests.at(-1).purpose, 'compaction')
  assert.doesNotMatch(text(h.requests.at(-1)), /STATE-/)
  await h.send(agent)
  assert.match(text(h.requests.at(-1).messages[0]), /压缩后新设定/)
  assert.equal(hasState(h.requests.at(-1).messages.at(-1)), true)
  overflow = true
  const before = h.requests.length
  await h.send(agent)
  assert.equal(h.requests.slice(before).filter(r => r.purpose === 'compaction').length, 1)
  assert.equal(h.requests.slice(before).filter(r => r.purpose !== 'compaction').length, 2)
  for (const request of h.requests.filter(r => r.purpose === 'compaction')) assert.doesNotMatch(text(request), /STATE-/)
  assert.doesNotMatch(text(agent.session.deriveMessages()), /STATE-/)
})

test('真实持久化恢复清理遗留快照，重复恢复不写多余清理记录', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qq-native-recovery-'))

  const h = await harness(t, { root })
  t.after(() => rm(root, { recursive: true, force: true }))
  let handle = await h.attach(), agent = handle.agent
  await h.send(agent)
  agent.session.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text: 'STATE-CRASH-LEFTOVER' }],
    source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: runtimeContextName, text: 'STATE-CRASH-LEFTOVER' }] } }), { surfaceOp: 'append' })
  await handle.dispose()
  handle = await h.attach('qq-native', true); agent = handle.agent
  assert.doesNotMatch(text(agent.session.deriveMessages()), /STATE-/)
  const seq = agent.session.seq
  await h.setup(agent.ctx, agent)
  clearRuntimeContext(agent)
  assert.equal(agent.session.seq, seq)
  await h.send(agent)
  assert.equal(h.requests.at(-1).messages.filter(hasState).length, 1)
  assert.doesNotMatch(text(h.requests.at(-1)), /STATE-CRASH-LEFTOVER/)
})

test('官方步骤压力压缩不含旧状态，当前状态可用，下一次组装同步 system', async t => {
  const h = await harness(t, { compact: { thresholdRatio: 0.01 } }), { agent } = await h.attach()
  await h.send(agent, 'conversation '.repeat(10000))
  const before = h.requests.length
  h.config.persona = '自动压缩后的设定'
  h.state = 'STATE-AFTER-PRESSURE'
  await h.send(agent)
  const requests = h.requests.slice(before)
  assert.ok(requests.some(request => request.purpose === 'compaction'))
  for (const request of requests.filter(request => request.purpose === 'compaction')) assert.doesNotMatch(text(request), /STATE-/)
  assert.match(text(h.requests.at(-1).messages[0]), /固定人设/)
  assert.match(text(h.requests.at(-1).messages.at(-1)), /STATE-AFTER-PRESSURE/)
  await h.send(agent)
  assert.match(text(h.requests.at(-1).messages[0]), /自动压缩后的设定/)
  assert.doesNotMatch(text(agent.session.deriveMessages()), /STATE-/)
})

test('清理写入失败时拒绝后续请求及 compact，修复后可幂等重试', async t => {
  const h = await harness(t, { compact: true }), { agent } = await h.attach()
  const append = agent.session.append.bind(agent.session)
  agent.session.append = (type, data, ...rest) => {
    if (type === 'developer/message' && data.message.source.kind === 'dsh-qq:state-cleared') throw new Error('probe clear failed')
    return append(type, data, ...rest)
  }
  await h.send(agent)
  assert.match(text(agent.session.deriveMessages()), /STATE-/)
  const before = h.requests.length
  await assert.rejects(h.ctx.compaction.compactNow(agent, new AbortController().signal), error => {
    assert.match(String(error.cause ?? error), /probe clear failed|状态区/)
    return true
  })
  assert.equal(h.requests.length, before)
  agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'blocked' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.equal(h.requests.length, before)
  assert.match(String(h.errors.at(-1)), /probe clear failed/)
  agent.session.append = append
  h.errors.length = 0
  clearRuntimeContext(agent)
  const seq = agent.session.seq
  clearRuntimeContext(agent)
  assert.equal(agent.session.seq, seq)
  await h.send(agent)
  assert.doesNotMatch(text(agent.session.deriveMessages()), /STATE-/)
})

test('请求中断清理；首次接入保留新版 system 消息，强制同步后重新锁定', async t => {
  let hang = false, started
  const gate = new Promise(resolve => { started = resolve })
  const h = await harness(t, { respond: async function* (request) {
    if (!hang) { yield* textResponse('ok'); return }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'partial' }
    started()
    await new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
  } })
  const { agent } = await h.attach('existing-system', false, false)
  agent.ctx.get('systemPrompt').section({ name: 'existing', order: 20, text: '原会话的 system' })
  await h.send(agent)
  const original = h.requests.at(-1).messages[0].content
  await h.setup(agent.ctx, agent)
  await h.send(agent)
  assert.deepEqual(h.requests.at(-1).messages[0].content, original)
  h.config.persona = '强制同步的新设定'
  await agent.ctx.get('systemPrompt').assemble({ ...assembleContextFor(agent), qqForceSystemSync: true })
  await h.send(agent)
  assert.match(text(h.requests.at(-1).messages[0]), /强制同步的新设定/)
  hang = true
  agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'cancel' }], source: { kind: 'user' } }))
  await gate
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  assert.doesNotMatch(text(agent.session.deriveMessages()), /STATE-/)
})
