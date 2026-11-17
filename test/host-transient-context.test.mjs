import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installChatSystem, createSystemPromptStore } from '../src/system-prompt.js'
import { clearRuntimeContext, buildRuntimeContext } from '../src/runtime-context.js'
import { createAddressClassifier } from '../src/address-classifier.js'
import { runtimeContextName } from '../src/session-view.js'
import { assertHostAccepted } from '../src/host-compatibility.js'
import { registerTools } from '../src/tools.js'
import { SILENT_HINT } from '../src/prompts.js'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createContextBudget } from '../src/context-budget.js'
import { createMessageStore } from '../src/message-store.js'
import { createKnowledge } from '../src/knowledge.js'
import { createMemory } from '../src/memory.js'

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

test('原生宿主独立摘要旧积压，无工具和用户事件；主轮只接纳摘要与近期原文', async t => {
  const h = await harness(t, { budget: true, compact: { headroomTokens: 100, thresholdRatio: 0.8 },
    modelInfo: { context: { contextWindow: 24000 }, defaultMaxTokens: 512 },
    async *respond(options) { yield* textResponse(options.purpose === 'qq-backlog-summary' ? '旧聊天已有事项已完成，来源序号1。' : '正常回复') },
  })
  h.config.backlogSummaryEnabled = true
  const { agent } = await h.attach()
  const record = { selfId: '10001', scope: 'private', peerId: '11001', sessionId: agent.session.id, agent }
  await h.send(agent, '先前已经处理过的一轮。'.repeat(200))
  const old = '旧消息：甲说之前约定的事情已经完成，乙确认收到。'.repeat(4000)
  h.messages.put(record, { id: 'old', body: old, source: {}, receivedAt: 1 })
  h.messages.put(record, { id: 'current', body: '本次触发消息需要保持原文', source: {}, receivedAt: 2 })
  const render = (rows, omitted, summary) => [summary ? `旧积压摘要：${summary.text}` : '', ...rows.map(row => row.body)].join('\n')
  const userEvents = () => agent.session.snapshotEvents().filter(event => event.type === 'user/message' &&
    (event.data.message ?? event.data).source?.kind === 'user').length
  const before = userEvents()
  const plan = await h.capacity.select(record, { runtimeContext: () => 'STATE-V1' }, h.messages, h.messages.summary(record).end, render)
  const auxiliary = h.requests.filter(request => request.purpose === 'qq-backlog-summary')
  assert.ok(auxiliary.length > 1)
  assert.equal(userEvents(), before)
  for (const request of auxiliary) {
    assert.deepEqual(request.tools, [])
    assert.doesNotMatch(text(request), /本次触发消息|STATE-V1|先前已经处理过/)
    assert.ok(await h.capacity.measure(request) <= (await h.capacity.inputBudget(request)).limit)
  }
  const compact = h.requests.find(request => request.purpose === 'compaction')
  assert.ok(compact)
  assert.doesNotMatch(text(compact), /本次触发消息|旧消息：|旧积压摘要|STATE-V1/)
  const id = h.messages.begin(record, record.sessionId, plan.selected, [], plan.summary)
  await h.send(agent, plan.body, { kind: 'user', qqDeliveryId: id, qqMessages: plan.selected.map(row => ({ id: row.id, seq: row.seq })) })
  h.messages.finish(id, 'processed')
  const main = h.requests.at(-1)
  assert.notEqual(main.purpose, 'qq-backlog-summary')
  assert.match(text(main.messages), /旧积压摘要|本次触发消息/)
  assert.doesNotMatch(main.system ?? '', /旧积压摘要|旧消息：/)
  assert.equal(h.messages.get(record, 'old').status, 'summarized')
  assert.equal(h.messages.get(record, 'current').status, 'processed')
})

async function harness(t, { root, respond, compact = false, budget = false, modelInfo = {}, agentOptions = {}, runtimeContext } = {}) {
  const ctx = new Context(), requests = [], errors = [], handles = []
  for (const plugin of [llm.default, sessionApi.default, Projections, SystemPrompt, tools.default, Native, AgentRegistry, TokenMeter]) await ctx.plugin(plugin)
  if (root) await ctx.plugin(Persistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (compact) await ctx.plugin(Compaction, { headroomTokens: 0, maxTokens: 128, retainTokens: 0,
    ...(typeof compact === 'object' ? compact : {}) })
  class Adapter extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model,
      ...(budget ? { defaultMaxTokens: 8192 } : {}), context: { contextWindow: 1000000 }, ...modelInfo } }
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
  const messages = budget ? createMessageStore() : null
  const capacity = budget ? createContextBudget({ ctx, config, store: messages }) : null
  if (messages) t.after(() => messages.close())
  let state = 'STATE-V1', renderCount = 0
  const setup = async (agentCtx, agent) => {
    await installChatSystem({ agentCtx, agent, config, store, capacity,
      meta: { selfId: '10001', scope: 'private', peerId: '11001' },
      runtimeContext: () => { renderCount++; return runtimeContext ? runtimeContext(config) : state } })
  }
  async function attach(id = 'qq-native', resume = false, managed = true) {
    const options = { agentOptions: { provider: 'mock', model: 'mock', ...agentOptions }, ...(managed ? { setup } : {}) }
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
  return { ctx, requests, errors, attach, send, setup, config, store, capacity, messages,
    get renderCount() { return renderCount }, set state(value) { state = value } }
}

test('限量状态区进入原生实际请求末尾，工具续调刷新，compact 无状态或遗漏资料', async t => {
  const home = await mkdtemp(join(tmpdir(), 'qq-native-state-budget-'))
  const memory = createMemory({ home, config: {} })
  t.after(async () => { memory.stop(); await rm(home, { recursive: true, force: true }) })
  let record, h
  h = await harness(t, { budget: true, compact: true,
    modelInfo: { context: { contextWindow: 24000 }, defaultMaxTokens: 512 },
    respond: (_options, requests) => requests.length === 1 ? toolResponse : textResponse('ok'),
    runtimeContext: config => buildRuntimeContext({ memory, config, record, capacity: h.capacity }),
  })
  const { agent } = await h.attach()
  record = { selfId: '10001', scope: 'private', peerId: '11001', agent }
  const data = memory.store.migrate(record)
  for (let i = 0; i < 40; i++) memory.store.change(data, { kind: 'fact', text: `资料${i}：` + '长资料😀'.repeat(100) })
  memory.store.write(record, data, data.revision)
  h.ctx.tools.register(defineContentToolFixture({ name: 'change_state', description: '更新状态', parameters: {}, async execute() {
    await memory.update(record, { id: data.entries[0].id, version: 1, status: 'removed' })
    return [{ type: 'text', text: '实际工具结果' }]
  } }))
  await h.send(agent, '查询当前资料及之前的聊天背景。'.repeat(100), { kind: 'user', qqMaySilent: true })
  assert.equal(h.requests.length, 2)
  for (const request of h.requests) {
    const tail = request.messages.at(-1)
    assert.ok(hasState(tail))
    assert.ok(await h.capacity.textCount(tail.content[0].text) <= Math.floor((24000 - 512) / 8))
    assert.match(text(tail), /未提供 \d+ 条，可用 qq_memory 查询/)
  }
  assert.match(text(h.requests[0].messages.at(-1)), /资料0：/)
  assert.doesNotMatch(text(h.requests[1].messages.at(-1)), /资料0：/)
  assert.equal(h.requests[1].messages.at(-2).role, 'tool')
  assert.doesNotMatch(text(agent.session.deriveMessages()), /长资料|未提供 \d+ 条，可用 qq_memory/)
  await h.ctx.compaction.compactNow(agent, new AbortController().signal)
  assert.doesNotMatch(text(h.requests.at(-1)), /长资料|未提供 \d+ 条，可用 qq_memory/)
})

test('实际请求中固定说明仅在 system，当前值在末尾；分类背景不重复 system 或改变主会话', async t => {
  const home = await mkdtemp(join(tmpdir(), 'qq-native-composition-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const memory = createMemory({ home, config: {} })
  t.after(() => memory.stop())
  const record = { selfId: '10001', scope: 'private', peerId: '11001' }
  const data = memory.store.migrate(record)
  memory.store.change(data, { kind: 'task', text: '当前事项甲' })
  memory.store.write(record, data, data.revision)
  const h = await harness(t, { compact: true,
    runtimeContext: config => buildRuntimeContext({ memory, config, record }),
    respond: (_options, requests) => requests.length === 1 ? toolResponse : textResponse('ok'),
  })
  Object.assign(h.config, { ownerIds: ['11001'], memberLabels: { '11001': '称呼甲' },
    faceRoot: home, stickerEnabled: false, faceCollectHint: '' })
  const { agent } = await h.attach()
  h.ctx.tools.register(defineContentToolFixture({ name: 'change_state', description: '修改测试状态', parameters: {}, execute() {
    h.config.memberLabels = { '11001': '称呼乙' }
    h.config.faceCollectHint = '只收藏虚构的蓝色方块'
    return [{ type: 'text', text: '工具的实际结果' }]
  } }))
  await h.send(agent, '当前消息的已有聊天背景。'.repeat(200), { kind: 'user', qqMaySilent: true })
  assert.equal(h.requests.length, 2)
  const [first, continued] = h.requests
  const system = text(first.messages[0])
  assert.match(system, /authorized 表示当前授权|当前事项与长期记忆/)
  assert.doesNotMatch(system, /称呼甲|称呼乙|当前事项甲|只收藏虚构/)
  assert.equal(text(continued.messages[0]), system)
  for (const request of h.requests) {
    const tail = text(request.messages.at(-1))
    assert.match(tail, /【当前资料】[\s\S]*当前事项甲[\s\S]*【本轮条件】/)
    assert.ok(tail.includes(SILENT_HINT))
    assert.doesNotMatch(tail, /跨轮跟进以|authorized 表示|qq_mface|mode=requested/)
    assert.doesNotMatch(text(request.messages.slice(0, -1)), /当前事项甲|称呼甲|称呼乙|只收藏虚构/)
  }
  assert.match(text(first.messages.at(-1)), /称呼甲/)
  assert.match(text(first.messages.at(-1)), /不自动收藏/)
  assert.match(text(continued.messages.at(-1)), /称呼乙/)
  assert.match(text(continued.messages.at(-1)), /只收藏虚构的蓝色方块/)
  assert.doesNotMatch(text(continued), /称呼甲/)
  assert.equal(continued.messages.at(-2).role, 'tool')
  assert.match(text(continued.messages.at(-2)), /工具的实际结果/)
  const mainContext = { header: { ...agent.session.requestHeader(), system: h.store.get(agent.session.id).text },
    messages: agent.session.deriveMessages(), runtimeContext: buildRuntimeContext({ memory, config: h.config, record }) }
  const before = text(mainContext), classified = []
  const gate = createAddressClassifier({ config: { addressClassifierEnabled: true, provider: 'mock', model: 'mock' },
    llm: { async *stream(options) { classified.push(options); yield* textResponse('no') } } })
  t.after(() => gate.stop())
  await gate.accept({ id: 'classifier-1', meta: record, body: '新消息', message: { text: '新消息' }, mainContext }, async () => false)
  assert.equal(classified.length, 1)
  const background = JSON.parse(classified[0].messages[0].content[0].text).mainContext
  assert.equal(background.header.system, mainContext.header.system)
  assert.equal(background.messages.filter(message => message.role === 'system').length, 0)
  assert.ok(background.messages.some(message => message.role === 'tool'))
  assert.equal(text(mainContext), before)
  assert.equal(agent.session.deriveMessages().filter(message => message.role === 'system').length, 1)
  assert.doesNotMatch(text(agent.session.deriveMessages()), /当前事项甲|称呼甲|称呼乙|【本轮条件】/)
  assert.ok(await h.ctx.compaction.compactNow(agent, new AbortController().signal))
  assert.doesNotMatch(text(h.requests.at(-1)), /当前事项甲|称呼甲|称呼乙|【本轮条件】/)
})

test('rc.2 的 128K 模型按显式 8K 输出预选消息，允许默认 64K 输出的压缩请求', async t => {
  const h = await harness(t, { budget: true,
    modelInfo: { defaultMaxTokens: 65536, context: { contextWindow: 131072 } },
    agentOptions: { maxTokens: 8192 }, compact: { headroomTokens: 65536, maxTokens: undefined } })
  const { agent } = await h.attach()
  const meta = { selfId: '10001', scope: 'private', peerId: '11001' }
  const record = { ...meta, owned: true, agent }
  h.messages.put(meta, { id: '1', body: '本次消息', message: { text: '本次消息' }, source: {}, receivedAt: 1, decision: 'yes' })
  const plan = await h.capacity.select(record, { runtimeContext: () => 'STATE-V1' }, h.messages, 1,
    selected => selected.map(row => row.body).join('\n'))
  assert.equal(plan.limit, 57344)
  assert.equal(plan.selected.length, 1)
  await h.send(agent, 'conversation '.repeat(500))
  assert.equal(h.requests[0].maxTokens, 8192)
  assert.ok(await h.ctx.compaction.compactNow(agent, new AbortController().signal))
  assert.equal(h.requests.at(-1).purpose, 'compaction')
  assert.equal(h.requests.at(-1).maxTokens, 65536)
  assert.deepEqual(h.errors, [])
  await h.send(agent)
  assert.equal(h.requests.at(-1).maxTokens, 8192)
})

test('rc.2 实际请求链的容量检查：工具续调、动态状态和宿主额外输入均进入最终检查', async t => {
  const h = await harness(t, { budget: true, respond: (_options, requests) => requests.length === 1 ? toolResponse : textResponse('ok') })
  const { agent } = await h.attach()
  h.ctx.tools.register(defineContentToolFixture({ name: 'change_state', description: 'test tool', parameters: {},
    execute: async () => [{ type: 'text', text: 'ok' }] }))
  await h.send(agent)
  assert.equal(h.requests.length, 2)
  assert.match(JSON.stringify(h.requests.at(-1)), /STATE-V1/)
  agent.ctx.get('systemPrompt').context({ name: 'huge-other-plugin', order: 20, text: '超大宿主资料 '.repeat(400000) })
  agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: '新的消息' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.equal(h.requests.length, 2, '超窗请求没有到达适配器')
  assert.ok(h.errors.some(error => error.message.includes('输入容量检查失败')))
})

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


test('真实 rc.2 工具选择：QQ 分组、关闭后的旧调用和普通 Agent 隔离', async t => {
  const h = await harness(t)
  Object.assign(h.config, { replyToPrivate: true, privateMode: 'open', groupMode: 'open', ownerIds: ['11001'] })
  const { agent } = await h.attach()
  const record = { selfId: '10001', scope: 'private', peerId: '11001', agent }
  const calls = []
  const manager = { selfId: '10001', find: id => id === agent.session.id ? record : null }
  const home = await mkdtemp(join(tmpdir(), 'qq-host-tools-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const knowledge = createKnowledge({ home })
  registerTools(h.ctx, { config: h.config, manager, home, knowledge, platform: 'linux',
    client: { async call(...args) { calls.push(args); return {} } }, logger: { info() {}, warn() {} } })
  await h.send(agent)
  const names = () => (h.requests.at(-1).tools ?? []).map(tool => tool.name)
  assert.ok(names().includes('qq_face'))
  assert.ok(names().includes('qq_send'))
  assert.ok(names().includes('qq_keep_face'))
  assert.ok(names().includes('qq_sources'))
  assert.ok(!names().includes('qq_search'))
  const systemBefore = h.requests.at(-1).messages.filter(message => message.role === 'system')
  const source = await knowledge.save({ selfId: '10001', scope: 'chat', chat: record, kind: 'pack', pack: 'ai-girls' })
  await h.send(agent)
  assert.ok(names().includes('qq_search'))
  assert.deepEqual(h.requests.at(-1).messages.filter(message => message.role === 'system'), systemBefore)
  const searchSelection = await h.ctx.tools.resolve({ agent, modelSelection: agent.model.current(), signal: new AbortController().signal })
  const search = searchSelection.view(agent).get('qq_search')
  assert.match((await search.execute({ query: '龙娘' }, { agent })).text, /GPT 娘/)
  knowledge.remove(source.id, '10001')
  await assert.rejects(search.execute({ query: '龙娘' }, { agent }), /不可用/)
  searchSelection.dispose()
  for (const name of ['qq_reply', 'qq_meme', 'qq_memo', 'qq_send_voice', 'qq_qzone_send']) assert.ok(!names().includes(name), name)
  const selection = await h.ctx.tools.resolve({ agent, modelSelection: agent.model.current(), signal: new AbortController().signal })
  const stale = selection.view(agent).get('qq_face')
  h.config.qqInteractionEnabled = false
  h.config.stickerEnabled = false
  h.config.voiceEnabled = true
  await assert.rejects(stale.execute({ id: 1 }, { agent }), /不可用/)
  assert.equal(calls.length, 0)
  selection.dispose()
  await h.send(agent)
  for (const name of ['qq_face', 'qq_poke', 'qq_react', 'qq_like', 'qq_mface', 'qq_faces', 'qq_send_voice']) assert.ok(!names().includes(name), name)
  h.config.qqInteractionEnabled = true
  h.config.qzoneEnabled = true
  await h.send(agent)
  assert.ok(names().includes('qq_face'))
  assert.ok(names().includes('qq_qzone_send'))
  agent.ctx.get('tools').restrict({ deny: ['qq_face'] })
  await h.send(agent)
  assert.ok(!names().includes('qq_face'), '尊重预设已有工具限制')
  assert.ok(names().includes('qq_poke'))
  const normal = await h.attach('ordinary-agent', false, false)
  await h.send(normal.agent)
  assert.ok(names().every(name => !name.startsWith('qq_')), '普通 Agent 不提供 QQ 工具')
})

test('真实 rc.2 工具续调重新选择工具，但不改写已锁定的 system', async t => {
  const h = await harness(t, { respond: (_options, requests) => requests.length === 1
    ? toolResponse.map(frame => {
      if (frame.type === 'tool-call-delta') return { ...frame, name: 'qq_face', argumentsDelta: '{"id":1}' }
      if (frame.type === 'block-end') return { ...frame, block: { ...frame.block, name: 'qq_face', arguments: '{"id":1}' } }
      return frame
    }) : textResponse('ok') })
  Object.assign(h.config, { replyToPrivate: true, privateMode: 'open', ownerIds: [] })
  const { agent } = await h.attach()
  const record = { selfId: '10001', scope: 'private', peerId: '11001' }
  let calls = 0
  registerTools(h.ctx, { config: h.config, manager: { selfId: '10001', find: id => id === agent.session.id ? record : null },
    home: tmpdir(), logger: { info() {}, warn() {} }, client: { async call() {
      calls++; h.config.qqInteractionEnabled = false
      return { message_id: 71 }
    } } })
  await h.send(agent)
  assert.equal(calls, 1)
  assert.equal(h.requests.length, 2)
  assert.ok(h.requests[0].tools.some(tool => tool.name === 'qq_face'))
  assert.ok(!h.requests[1].tools.some(tool => tool.name === 'qq_face'))
  const systems = request => request.messages.filter(message => message.role === 'system')
  assert.deepEqual(systems(h.requests[0]), systems(h.requests[1]))
})

test('真实 rc.2 资料工具调用：搜索后可读取原文，结果进入工具续调而非system', async t => {
  const h = await harness(t, { respond: (_options, requests) => {
    if (requests.length > 2) return textResponse('ok')
    let args = { query: '龙娘' }
    if (requests.length === 2) {
      const message = requests.at(-1).messages.filter(message => message.role === 'tool').at(-1)
      const hit = JSON.parse(message.content.map(block => block.text || '').join('')).results[0]
      args = { action: 'read', sourceId: hit.sourceId, documentId: hit.documentId, version: hit.version }
    }
    return toolResponse.map(frame => {
      if (frame.type === 'tool-call-delta') return { ...frame, id: llm.ToolCallId(`search-${requests.length}`), name: 'qq_search', argumentsDelta: JSON.stringify(args) }
      if (frame.type === 'block-end') return { ...frame, block: { ...frame.block, id: llm.ToolCallId(`search-${requests.length}`), name: 'qq_search', arguments: JSON.stringify(args) } }
      return frame
    })
  } })
  const home = await mkdtemp(join(tmpdir(), 'qq-host-search-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const knowledge = createKnowledge({ home })
  Object.assign(h.config, { replyToPrivate: true, privateMode: 'open' })
  const { agent } = await h.attach()
  const record = { selfId: '10001', scope: 'private', peerId: '11001' }
  await knowledge.save({ selfId: '10001', scope: 'chat', chat: record, kind: 'pack', pack: 'ai-girls' })
  registerTools(h.ctx, { config: h.config, manager: { selfId: '10001', find: id => id === agent.session.id ? record : null },
    knowledge, home, logger: { info() {}, warn() {} }, client: {} })
  await h.send(agent)
  assert.deepEqual(h.errors, [])
  assert.equal(h.requests.length, 3)
  assert.match(JSON.stringify(h.requests[1].messages.filter(message => message.role === 'tool')), /GPT 娘/)
  const readMessage = h.requests[2].messages.filter(message => message.role === 'tool').at(-1)
  const read = JSON.parse(readMessage.content.map(block => block.text || '').join(''))
  assert.match(read.text, /genderswapai.com/)
  assert.equal(read.partial, false)
  assert.equal(read.nextOffset, null)
  assert.doesNotMatch(JSON.stringify(h.requests[0].messages.filter(message => message.role === 'system')), /GPT 娘/)
})

for (const [name, args] of [
  ['qq_poke', {}], ['qq_react', { emoji_id: '1' }], ['qq_like', {}],
  ['qq_send', { text: '测试' }], ['qq_send_voice', { text: '测试' }], ['qq_send_image', { file: 'test.png' }],
  ['qq_face', { id: '1' }], ['qq_mface', { emoji_id: '100', emoji_package_id: '200' }],
  ['qq_send_file', { file: 'test.txt' }], ['qq_recall', {}], ['qq_images', {}],
  ['qq_keep_face', { path: 'missing-fixture.png', mode: 'requested' }],
]) {
  test(`原生rc.2执行器：${name}失败标记进入后续模型请求`, async t => {
    const h = await harness(t, { respond: (_options, requests) => requests.length > 1 ? textResponse('ok') : toolResponse.map(frame => {
      if (frame.type === 'tool-call-delta') return { ...frame, name, argumentsDelta: JSON.stringify(args) }
      if (frame.type === 'block-end') return { ...frame, block: { ...frame.block, name, arguments: JSON.stringify(args) } }
      return frame
    }) })
    Object.assign(h.config, { replyToPrivate: true, privateMode: 'open', voiceEnabled: true })
    const { agent } = await h.attach()
    const record = { selfId: '10001', scope: 'private', peerId: '11001', lastSenderId: '11001', lastMessageId: 7, lastSentMessageId: 8 }
    registerTools(h.ctx, { config: h.config, manager: { selfId: '10001', find: id => id === agent.session.id ? record : null },
      platform: 'win32', synthesize: async () => Buffer.from('audio'), logger: { info() {}, warn() {} },
      client: { call: async () => { throw Object.assign(new Error('private protocol detail'), { onebotDelivery: 'rejected' }) } } })
    await h.send(agent)
    assert.equal(h.requests.length, 2)
    const result = h.requests[1].messages.filter(message => message.role === 'tool').at(-1)
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result.content), /协议拒绝|取消息失败|收藏文件不存在/)
    assert.doesNotMatch(JSON.stringify(result.content), /private protocol detail/)
    assert.equal(record.lastSentMessageId, 8)
  })
}

test('原生rc.2执行器：空收藏和无图片均是成功空结果，动态状态仍在末尾', async t => {
  const h = await harness(t, { respond: (_options, requests) => {
    if (requests.length > 2) return textResponse('ok')
    const name = requests.length === 1 ? 'qq_faces' : 'qq_images'
    return toolResponse.map(frame => {
      if (frame.type === 'tool-call-delta') return { ...frame, name, argumentsDelta: '{}' }
      if (frame.type === 'block-end') return { ...frame, block: { ...frame.block, name, arguments: '{}' } }
      return frame
    })
  } })
  const home = await mkdtemp(join(tmpdir(), 'qq-host-empty-tools-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  Object.assign(h.config, { replyToPrivate: true, privateMode: 'open', cwd: home })
  const { agent } = await h.attach()
  const record = { selfId: '10001', scope: 'private', peerId: '11001', lastMessageId: 7 }
  registerTools(h.ctx, { config: h.config, manager: { selfId: '10001', find: () => record }, home,
    logger: { info() {}, warn() {} }, client: { call: async () => ({ message_type: 'private', sender: { user_id: 11001 }, message: [] }) } })
  await h.send(agent)
  assert.equal(h.requests.length, 3)
  const results = h.requests.at(-1).messages.filter(message => message.role === 'tool')
  assert.equal(results.length, 2)
  assert.ok(results.every(message => !message.isError))
  assert.equal(JSON.parse(results[0].content[0].text).total, 0)
  assert.deepEqual(JSON.parse(results[1].content[0].text).paths, [])
  assert.equal(h.requests.at(-1).messages.at(-1).source.kind, 'runtime-context')
})

test('原生rc.2执行器：记忆列表和版本续读通过输出校验，不携带整段历史', async t => {
  let entry, offset = 0, snapshot
  const h = await harness(t, { respond: (_options, requests) => {
    if (requests.length > 1) {
      const prior = JSON.parse(requests.at(-1).messages.filter(message => message.role === 'tool').at(-1).content[0].text)
      if (requests.length > 2) {
        if (prior.nextOffset === null) return textResponse('ok')
        offset = prior.nextOffset
        snapshot = prior.snapshot
      }
    }
    const args = requests.length === 1 ? { action: 'list' } : { action: 'read', id: entry.id, version: 1, offset, ...(snapshot ? { snapshot } : {}) }
    return toolResponse.map(frame => {
      if (frame.type === 'tool-call-delta') return { ...frame, id: llm.ToolCallId(`mem-${requests.length}`), name: 'qq_memory', argumentsDelta: JSON.stringify(args) }
      if (frame.type === 'block-end') return { ...frame, block: { ...frame.block, id: llm.ToolCallId(`mem-${requests.length}`), name: 'qq_memory', arguments: JSON.stringify(args) } }
      return frame
    })
  } })
  const home = await mkdtemp(join(tmpdir(), 'qq-host-memory-tool-'))
  const memory = createMemory({ home, config: {} })
  t.after(async () => { memory.stop(); await rm(home, { recursive: true, force: true }) })
  Object.assign(h.config, { replyToPrivate: true, privateMode: 'open' })
  const { agent } = await h.attach()
  const record = { selfId: '10001', scope: 'private', peerId: '11001' }
  const body = '"\\\n😀'.repeat(2500)
  entry = await memory.update(record, { kind: 'fact', text: body })
  registerTools(h.ctx, { config: h.config, manager: { selfId: '10001', find: () => record, memory }, home,
    logger: { info() {}, warn() {} }, client: {} })
  await h.send(agent)
  const results = h.requests.at(-1).messages.filter(message => message.role === 'tool')
  assert.ok(results.every(message => !message.isError))
  const pages = results.map(message => { assert.ok(message.content[0].text.length <= 12000); return JSON.parse(message.content[0].text) })
  assert.equal(pages[0].entries[0].partial, true)
  assert.equal(JSON.parse(pages.slice(1).map(page => page.text).join('')).text, body)
})
