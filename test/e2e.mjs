/**
 * 端到端自检：假 NapCat + 假宿主 ctx，把 dsh-qq 的整条链路跑一遍。
 *
 *   node test/e2e.mjs
 *
 * 覆盖：连接鉴权 → 私聊入站 → agent.followup → assistant/message 出站 →
 *       群聊入站 → requireMention 门槛 → 白名单拒绝。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockNapcat } from './mock-napcat.mjs'
import { apply, Config } from '../src/index.js'
import { buildChatPrompt } from '../src/prompts.js'
import { createMockPromptScope } from './mock-dsh.mjs'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { sensitiveContentNotice } from '../src/audit.js'

// 每次使用独立临时数据目录，避免写入用户部署或恢复上次的会话与 system 快照。
const E2E_HOME = mkdtempSync(join(tmpdir(), 'dsh-qq-e2e-home-'))
process.env.DSH_HOME = E2E_HOME
const E2E_WORKSPACE = mkdtempSync(join(tmpdir(), 'dsh-qq-e2e-ws-'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, { timeout = 5000, interval = 50, what = '条件' } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await fn()) return
    await sleep(interval)
  }
  throw new Error(`等待超时：${what}`)
}

/** 一个最小的假宿主：提供 agents 服务和事件总线。 */
function createFakeCtx() {
  const instanceHome = mkdtempSync(join(E2E_HOME, 'instance-'))
  const handlers = new Map()
  const created = []
  const agents = {
    get: () => undefined,
    resume: async () => {
      throw new Error('没有历史会话')
    },
    create: async ({ sessionId, setup, meta }) => {
      const agentCtx = createMockPromptScope(ctx, meta?.cwd)
      let idle = Promise.resolve()
      const agent = {
        id: sessionId, ctx: agentCtx,
        model: { current: () => ({ provider: 'mock', model: 'mock-model' }) },
        session: { id: sessionId, header: { id: sessionId }, events: [],
          append(type, data, surface) { this.events.push({ type, data, seq: this.events.length, ...surface }) },
          snapshotEvents() { return [...this.events] },
          deriveMessages() { return this.events.filter(event => ['user/message', 'assistant/message'].includes(event.type))
            .map(event => ({ role: event.type.split('/')[0], ...(event.data.message ?? event.data) })) },
          requestHeader() { return this.events.findLast(event => event.type === 'request/header')?.data.header },
        },
        system: '',
        received: [],
        injected: [],
        followup(message) {
          this.received.push(message)
          idle = idle.then(async () => {
            this.session.append('user/message', message)
            this.system = renderPrompt(await agentCtx.get('systemPrompt').assemble(assembleContextFor(this)))
            const options = { ...this.model.current(), sessionId, system: this.system, messages: this.session.deriveMessages(), tools: [] }
            const chain = [...handlers.get('llm/stream') ?? []].reduceRight((next, fn) => () => fn(options, next), async function* () {})
            for await (const _ of chain()) {}
            this.session.events.push({ type: 'request/header', seq: this.session.events.length, data: { header: { system: this.system } } })
            this.session.append('turn/end', { reason: { kind: 'completed' } })
          })
        },
        inject(message) {
          this.injected.push(message)
        },
        whenIdle() { return idle },
      }
      await setup?.(agentCtx, agent)
      created.push(agent)
      return { agent, dispose: async () => {} }
    },
  }
  const ctx = {
    agents,
    get: name => name === 'sessionProjections' ? {
      async register(definition) {
        return { readerFor: session => () => session.events.reduce((state, event) => definition.apply(state, event), definition.init(session.header)) }
      },
    } : name === 'dshHomePath' ? leaf => join(instanceHome, leaf) : name === 'llm' ? {
      prepareCall: async config => ({ config: { maxTokens: 8192, ...config }, context: { contextWindow: 1000000 } }),
    } : undefined,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set())
      handlers.get(name).add(fn)
      return () => handlers.get(name)?.delete(fn)
    },
    emit(name, ...args) {
      if (name === 'session/event' && args[1].seq === undefined) {
        args[1].seq = args[0].events.length
        args[0].events.push(args[1])
      }
      return Promise.all([...handlers.get(name) ?? []].map((fn) => fn(...args)))
    },
  }
  return { ctx, created }
}

function textOf(message) {
  const parts = message?.content ?? []
  return parts.map((p) => (p?.type === 'text' ? p.text : '')).join('')
}

const TOKEN = 'test-token-123'

const mock = await startMockNapcat({ port: 0, token: TOKEN, selfId: 10001, selfName: '小满', quiet: true })
await mock.start()
const PORT = mock.port

const { ctx, created } = createFakeCtx()
const config = Config({
  wsUrl: `ws://127.0.0.1:${PORT}`,
  accessToken: TOKEN,
  // 会话文件、聊天记录、事实卡都写到临时工作区，别落进仓库的 `会话/`
  workspaceRoot: E2E_WORKSPACE,
  requireMention: true,
  groupMode: 'open',
  privateMode: 'open',
  splitDelayMs: 0,
  replyDelayMeanMs: 0,
  splitDelayMeanMs: 0,
  mergeWindowMs: 0, // 连发合并单独用一个用例验，别让每条断言都等 5 秒
  groupMinGapMs: 0, // 间隔由真实部署管，测试里关掉免得每个断言都要等 4 秒
  groupReplyGapMs: 0, // 同上：均匀间隔单独用一个用例验，别拖慢其他断言
  persona: '你叫小满，是个住在电脑里的助手。',
  ownerIds: ['11001'],
  peerBots: ['10002'], // 测试里把「另一个机器人」登记成同类，才测得了「开关关着不接」
})

apply(ctx, config)
await waitFor(() => mock.clientCount === 1, { what: '插件连上假 NapCat' })
console.log('✓ 连接与鉴权通过')

// —— 私聊 ——
mock.emitPrivateText({ userId: 11001, nickname: '朋友', text: '在吗在吗', messageId: 101 })
await waitFor(() => created.length === 1 && created[0].received.length === 1, { what: '私聊入站' })
const privateAgent = created[0]
assert.match(textOf(privateAgent.received[0]), /在吗在吗/, '私聊正文应该原样进 agent')
await privateAgent.whenIdle()
assert.match(privateAgent.system, /你叫小满/, 'persona 应该放进 system')
assert.match(privateAgent.system, /【聊天与工具】/, 'system 应该带内置聊天规矩')
assert.doesNotMatch(textOf(privateAgent.received[0]), /你叫小满|【聊天与工具】/)
assert.match(
  textOf(privateAgent.received[0]),
  /\[现在是 \d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}（(凌晨|早上|上午|中午|下午|傍晚|晚上|深夜)）；/,
  '私聊正文应该带一行「现在是 …」的人话时间',
)
console.log('✓ 私聊入站 → agent.followup')

// 出站：模拟宿主抛一条 assistant/message
ctx.emit('session/event', privateAgent.session, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的在的～' }] } },
})
await waitFor(() => mock.calls.some((c) => c.action === 'send_private_msg'), { what: '私聊出站' })
const sentPrivate = mock.calls.find((c) => c.action === 'send_private_msg')
assert.equal(Number(sentPrivate.params.user_id), 11001)
assert.match(JSON.stringify(sentPrivate.params.message), /在的在的/)
console.log('✓ assistant/message → send_private_msg')

// 重复推同一条不应重复发
const before = mock.calls.filter((c) => c.action === 'send_private_msg').length
ctx.emit('session/event', privateAgent.session, {
  type: 'assistant/message',
  data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '在的在的～' }] } },
})
await sleep(200)
assert.equal(
  mock.calls.filter((c) => c.action === 'send_private_msg').length,
  before,
  '同一条文本不应重复发送',
)
console.log('✓ 重复消息去重')

// 聊天规矩 / persona 只在会话首条注入一次，第二条不该重复
mock.emitPrivateText({ userId: 11001, nickname: '朋友', text: '再问一句', messageId: 111 })
await waitFor(() => privateAgent.received.length === 2, { what: '第二条私聊' })
assert.match(textOf(privateAgent.received[1]), /再问一句/)
assert.doesNotMatch(textOf(privateAgent.received[1]), /【聊天与工具】/, '聊天规矩不应每条重复注入')
assert.doesNotMatch(textOf(privateAgent.received[1]), /你叫小满/, 'persona 不应每条重复注入')
console.log('✓ 聊天规矩只注入一次')

// 私聊保留来源与授权标记，不从授权身份推导关系称呼。
assert.match(privateAgent.system, /【消息来源与授权】/)
assert.doesNotMatch(privateAgent.system, /他的话优先|对面这位是你的/)
assert.match(textOf(privateAgent.received[0]), /· 授权账号[^\n]*⟩ 在吗在吗/)
console.log('✓ 私聊来源标记与称呼分离')

// —— 群聊：没 @ 不该触发 ——
mock.emitGroupText({ groupId: 88888, userId: 1, nickname: '路人', text: '今天吃什么', messageId: 201 })
await sleep(300)
assert.equal(created.reduce((n, agent) => n + agent.received.length, 0), privateAgent.received.length, '没 @ 的群消息不应该启动主模型')
console.log('✓ requireMention 挡住了没 @ 的群消息')

// —— 群聊：@ 了应该触发 ——
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  self_id: 10001,
  group_id: 88888,
  user_id: 1,
  message_id: 202,
  raw_message: '[CQ:at,qq=10001] 在不在',
  message: [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 在不在' } },
  ],
  sender: { user_id: 1, nickname: '路人' },
})
await waitFor(() => created.length === 2 && created[1].received.length === 1, { what: '群聊入站' })
console.log('✓ @ 之后群聊入站')

const groupAgent = created[1]

// —— 保活期内，@ 别人（另一个机器人）的消息不该接 ——
// 刚 @ 过它，保活期是开着的；这条 @ 的是 99999，不是在跟我们说话。
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: 10001,
  group_id: 88888,
  user_id: 1,
  message_id: 203,
  raw_message: '[CQ:at,qq=99999] 来帮它测一下',
  message: [
    { type: 'at', data: { qq: '99999', name: '另一个机器人' } },
    { type: 'text', data: { text: ' 来帮它测一下' } },
  ],
  sender: { user_id: 1, nickname: '路人' },
})
await sleep(300)
assert.equal(groupAgent.received.length, 1, '@ 的是别人，保活期内也不该投给 agent')
console.log('✓ 保活期内 @ 别人的消息被挡下')

// 固定规则解释来源，具体授权账号由状态区提供。
await groupAgent.whenIdle()
assert.match(groupAgent.system, /【消息来源与授权】/)
assert.match(groupAgent.system, /称呼.*表达偏好/)
assert.match(
  textOf(groupAgent.received[0]),
  /⟨\S+ \(\d+\)\S* \d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}（(凌晨|早上|上午|中午|下午|傍晚|晚上|深夜)）⟩/,
  '群历史行应该自带星期和时段',
)
console.log('✓ 群聊注入认人规矩')

// 群里最容易翻车的两段规矩：认不出「哪句是我说的」、被冲了就开始道歉
assert.match(groupAgent.system, /谁是「你」/, '群聊应该注入「谁是你在说」的规矩')
assert.match(groupAgent.system, /其他成员和其他机器人的发言属于他们/, '其他机器人的话不能冒认成自己的')
assert.match(groupAgent.system, /【分歧与纠错】/, '应该提供通用纠错规则')

// 主人在群里说话 → 群历史行标「· 主人」
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  self_id: 10001,
  group_id: 88888,
  user_id: 11001,
  message_id: 233,
  raw_message: '[CQ:at,qq=10001] 我回来了',
  message: [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 我回来了' } },
  ],
  sender: { user_id: 11001, nickname: '主人' },
})
await waitFor(() => groupAgent.received.length === 2, { what: '主人群聊入站' })
assert.match(textOf(groupAgent.received[1]), /· 授权账号/, '授权账号发言应使用中性标记')
assert.match(textOf(groupAgent.received[0]), /\(1\)/, '群友发言不该被标成主人')
console.log('✓ 群里认主人：主人打标、群友保持陌生人')

ctx.emit('session/event', groupAgent.session, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的在的' }] } },
})
await waitFor(() => mock.calls.some((c) => c.action === 'send_group_msg'), { what: '群聊出站' })
const sentGroup = mock.calls.find((c) => c.action === 'send_group_msg')
assert.equal(Number(sentGroup.params.group_id), 88888)
assert.ok(!JSON.stringify(sentGroup.params.message).includes('CQ:at'), '不该把 CQ 码原样发出去')
console.log('✓ assistant/message → send_group_msg（未泄漏 CQ 码）')

// 敏感内容检查：路径正常发送；明确的密钥阻止原文并提示。
{
  const before = mock.calls.filter((c) => c.action === 'send_group_msg').length
  ctx.emit('session/event', groupAgent.session, {
    type: 'assistant/message',
    data: {
      turn: 2,
      step: 1,
      message: { content: [{ type: 'text', text: '文件就在 D:\\鲸鲸的专用文件\\本地记忆区 里' }] },
    },
  })
  await sleep(150)
  const after = mock.calls.filter((c) => c.action === 'send_group_msg').length
  assert.equal(after, before + 1, '路径讨论应正常发送')

  ctx.emit('session/event', groupAgent.session, {
    type: 'assistant/message',
    data: {
      turn: 2,
      step: 2,
      message: { content: [{ type: 'text', text: '密钥是 sk-abcdefghijklmnopqrstuvwx，请不要泄漏。' }] },
    },
  })
  await sleep(150)
  const afterSecret = mock.calls.filter((c) => c.action === 'send_group_msg').length
  assert.equal(afterSecret, before + 2, '凭据原文应替换为固定提示')
  assert.ok(JSON.stringify(mock.calls.filter(c => c.action === 'send_group_msg').at(-1)).includes(sensitiveContentNotice))
  assert.ok(!JSON.stringify(mock.calls).includes('sk-abcdefghijklmnopqrstuvwx'))
  await ctx.emit('session/event', groupAgent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
}
console.log('✓ 敏感内容检查：路径正常发送，凭据原文被阻止并提示')

// 自己的回复已在宿主 assistant 历史，不能再以“最近历史”重复补入新消息。
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  self_id: 10001,
  group_id: 88888,
  user_id: 1,
  message_id: 204,
  raw_message: '[CQ:at,qq=10001] 再说一遍',
  message: [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 再说一遍' } },
  ],
  sender: { user_id: 1, nickname: '路人' },
})
await waitFor(() => groupAgent.received.length === 3, { what: '第二轮群聊入站' })
assert.ok(groupAgent.session.deriveMessages().some(message => message.role === 'assistant' && textOf(message).includes('在的在的')))
assert.doesNotMatch(textOf(groupAgent.received[2]), /在的在的/)
console.log('✓ 自己说的话保留为 assistant 历史，不重复补入新用户消息')

// —— 必须 @ 是硬限制：后续消息和引用只能作背景 ——
const beforeOther = groupAgent.received.length
mock.emitGroupText({ groupId: 88888, userId: 2, nickname: '另一个人', text: '我也说一句', messageId: 301 })
mock.emitGroupText({ groupId: 88888, userId: 1, nickname: '路人', text: '那我再问一句', messageId: 302 })
mock.emitEvent({ post_type: 'message', message_type: 'group', self_id: 10001, group_id: 88888, user_id: 3,
  message_id: 303, message: [{ type: 'reply', data: { id: '77' } }, { type: 'text', data: { text: '引用补充' } }], sender: { nickname: '引用者' } })
await sleep(300)
assert.equal(groupAgent.received.length, beforeOther)
mock.emitGroupText({ groupId: 88888, userId: 1, nickname: '路人', text: '现在回答', messageId: 304, atSelf: true })
await waitFor(() => groupAgent.received.length === beforeOther + 1)
assert.match(textOf(groupAgent.received.at(-1)), /那我再问一句/)
assert.equal(groupAgent.received.at(-1).source.qqMaySilent, false)
assert.doesNotMatch(textOf(groupAgent.received.at(-1)), /\[SILENT\]/)
console.log('✓ 后续消息和引用不能绕过必须 @，触发时提供背景')

// 模型真回了 [SILENT] → 一个字节都不发出去
const beforeSilentSend = mock.calls.filter((c) => c.action === 'send_group_msg').length
ctx.emit('session/event', groupAgent.session, {
  type: 'assistant/message',
  data: { turn: 9, step: 1, message: { content: [{ type: 'text', text: '[SILENT]' }] } },
})
await sleep(300)
assert.equal(
  mock.calls.filter((c) => c.action === 'send_group_msg').length,
  beforeSilentSend,
  '模型输出 [SILENT] 时不应该发出任何消息',
)
console.log('✓ 模型回 [SILENT] 就不发')

// —— 同类机器人（群里另一个机器人）：吵架开关关着就完全不接，连 @ 都不接 ——
assert.equal(config.botChatEnabled, false, '默认应该关着：同类之间的帐先不算')
const beforePeer = groupAgent.received.length
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: 10001,
  group_id: 88888,
  user_id: 10002,
  message_id: 305,
  raw_message: '[CQ:at,qq=10001] 来，你说话呀',
  message: [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 来，你说话呀' } },
  ],
  sender: { user_id: 10002, nickname: '同类机器人' },
})
await sleep(300)
assert.equal(groupAgent.received.length, beforePeer, '同类机器人发言，开关关着不该接（@ 也不接）')
console.log('✓ 同类机器人：开关关着连 @ 都不接')

// 打开开关 → 可以接，并且注入「同类机器人」那段规矩
config.botChatEnabled = true
mock.emitEvent({
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: 10001,
  group_id: 88888,
  user_id: 10002,
  message_id: 306,
  raw_message: '[CQ:at,qq=10001] 来，你说话呀',
  message: [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 来，你说话呀' } },
  ],
  sender: { user_id: 10002, nickname: '同类机器人' },
})
await waitFor(() => groupAgent.received.length === beforePeer + 1, { what: '同类机器人（开关已开）入站' })
// 单独验证规则组装；已运行会话继续遵守 system 锁定及同步流程。
const promptOn = buildChatPrompt({ ...config, botChatEnabled: true }, { isGroup: true })
const promptOff = buildChatPrompt({ ...config, botChatEnabled: false }, { isGroup: true })
assert.match(promptOn, /【其他机器人】/, '开关开着应该注入机器人聊天规则')
assert.match(promptOn, /是否接话仍看消息指向和内容/, '需要按消息指向判断是否接话')
assert.match(promptOn, /避免互相重复应声/, '避免机器人之间无意义循环')
assert.doesNotMatch(promptOff, /【其他机器人】/, '开关关着不该注入机器人聊天规则')
console.log('✓ 同类机器人：开关打开才接，并带上同类规矩')

// 同类发言在群历史里要单独标出来，不然又分不清「这句是谁说的」
mock.emitGroupText({ groupId: 88888, userId: 10002, nickname: '同类机器人', text: '我在旁边看着', messageId: 307, atSelf: true })
await waitFor(() => groupAgent.received.length === beforePeer + 2, { what: '同类机器人续话' })
assert.match(textOf(groupAgent.received[beforePeer + 1]), /· 同类机器人/, '同类发言在历史里应该标「· 同类机器人」')
console.log('✓ 同类机器人在历史里标「· 同类机器人」')

// —— 没有 @ 就不接，主人也一样（2026-10-24 取消「主人永久免 @」）——
// 用一个没人 @ 过的新群，免得蹭到前面用例开出来的窗口
const totalBefore = created.reduce((n, a) => n + a.received.length, 0)
mock.emitGroupText({ groupId: 88891, userId: 11001, nickname: '主人', text: '我随便说一句', messageId: 308 })
await sleep(500)
const totalAfter = created.reduce((n, a) => n + a.received.length, 0)
assert.equal(totalAfter, totalBefore, '没 @ 也没在保活期，主人说话也不该投递')
console.log('✓ 没 @ 就不接，主人也不例外')

// —— 没 @ 但叫了名字 / 点名提问：算在叫它（2026-10-25，学 qq-bridge 的 evaluateWakeTriggerV2）——
const countAll = () => created.reduce((n, agent) => n + agent.received.length, 0)
const beforeName = countAll()
mock.emitGroupText({ groupId: 88895, userId: 10003, nickname: '甲', text: '小满你在不在', messageId: 309 })
await sleep(100)
assert.equal(countAll(), beforeName)
console.log('✓ 名字和问句不能绕过必须 @')

config.groupMentionOverrides = { '88890': false }
config.groupMessageIntervalMs = 250
const beforeBatch = countAll()
mock.emitGroupText({ groupId: 88890, userId: 10004, nickname: '甲', text: '等待合并的第一句', messageId: 501 })
await sleep(100)
mock.emitGroupText({ groupId: 88890, userId: 10005, nickname: '乙', text: '等待合并的第二句', messageId: 502 })
assert.equal(countAll(), beforeBatch)
await waitFor(() => countAll() === beforeBatch + 1)
const batched = created.flatMap(agent => agent.received).find(message => textOf(message).includes('等待合并的第一句'))
assert.match(textOf(batched), /等待合并的第二句/)
assert.equal(batched.source.qqMaySilent, true)
config.groupMentionOverrides = {}
console.log('✓ 免 @ 群定时合并普通消息并允许沉默')

// —— 跳过的群消息也要进上下文（2026-10-24 群里实测踩的坑）——
// 群友 A 说了个梗没 @ 我们 → 跳过；两分钟后主人接一句同款的话，
// 它却顺着主人的话往下编 —— 因为它压根没看见前面那句。
// 跳过归跳过（不叫醒它），但话得让它看得见。
mock.emitGroupText({ groupId: 88889, userId: 20001, nickname: '群友甲', text: '天意的大手发力了', messageId: 401 })
await sleep(300)
mock.emitGroupText({ groupId: 88889, userId: 20001, nickname: '群友甲', text: '@机器人 这啥意思', messageId: 402, atSelf: true })
await waitFor(
  () => created.some((a) => a.received.some((m) => textOf(m).includes('这啥意思'))),
  { what: '被跳过的群消息补进上下文' },
)
const backlogged = created
  .flatMap((a) => a.received.map((m) => textOf(m)))
  .find((t) => t.includes('这啥意思'))
assert.match(backlogged, /天意的大手发力了/, '前面被跳过的消息应该补进上下文，不然它接话只能瞎猜')
console.log('✓ 跳过的群消息会补进上下文（接话不再瞎猜）')

// —— 长文本切块 ——
const longText = '这是一段用来测试切块的长文字。'.repeat(80)
ctx.emit('session/event', groupAgent.session, {
  type: 'assistant/message',
  data: { turn: 1, step: 9, message: { content: [{ type: 'text', text: longText }] } },
})
await sleep(400)
const groupSends = mock.calls.filter((c) => c.action === 'send_group_msg').length
assert.ok(groupSends >= 2, `长文本应该被切成多条发出去，实际 ${groupSends} 条`)
console.log(`✓ 长文本自动切块（${groupSends} 条）`)

// —— 白名单模式拦人 ——
const { ctx: ctx2, created: created2 } = createFakeCtx()
const config2 = Config({
  wsUrl: `ws://127.0.0.1:${PORT}`,
  accessToken: TOKEN,
  privateMode: 'allowlist',
  privateAllow: ['11001'],
  mergeWindowMs: 0,
  splitDelayMs: 0,
  replyDelayMeanMs: 0,
  splitDelayMeanMs: 0,
})
apply(ctx2, config2)
await waitFor(() => mock.clientCount === 2, { what: '第二个实例连上' })
mock.emitPrivateText({ userId: 42, nickname: '陌生人', text: '你好', messageId: 301 })
await sleep(300)
assert.equal(created2.length, 0, '白名单外的私聊应该被拦下')
mock.emitPrivateText({ userId: 11001, nickname: '朋友', text: '是我', messageId: 302 })
await waitFor(() => created2.length === 1, { what: '白名单内私聊放行' })
console.log('✓ 私聊白名单：陌生人拦下、自己人放行')

// —— 上下文守卫：压缩后补回聊天规矩 ——
ctx.emit('session/event', privateAgent.session, { type: 'compaction/end', data: {} })
await sleep(100)
assert.equal(privateAgent.injected.length, 0, '压缩后不持久追加状态卡')
mock.emitPrivateText({ userId: 11001, nickname: '朋友', text: '刚才说到哪了', messageId: 401 })
// 别盯死某一个 agent、也别数条数：
//   - 压缩之后 record 可能已经被换过（新 record → 新 agent），看「谁收到了」比看「第几个」稳；
//   - 私聊还有可配的「连发合并」窗口，条数取决于时序，不取决于功能对不对。
await waitFor(
  () =>
    created.concat(created2).some((a) => a.received.some((m) => /刚才说到哪了/.test(textOf(m)))),
  { what: '压缩后的私聊' },
)
const afterCompact = created
  .concat(created2)
  .flatMap((a) => a.received.map(textOf))
  .find((t) => /刚才说到哪了/.test(t))
assert.doesNotMatch(afterCompact, /【聊天与工具】/, '压缩后不再把固定规则写入用户消息')
console.log('✓ 压缩后不追加旧状态卡')

// —— 上下文守卫：压力超过阈值主动换会话 ——
ctx.emit('session/event', privateAgent.session, {
  type: 'request/context',
  data: { provider: 'deepseek-account', model: 'deepseek-flash', contextWindow: 10000 },
})
ctx.emit('session/event', privateAgent.session, {
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'text', text: '嗯' }] },
    usage: { inputTokens: 5000, outputTokens: 10, cacheReadTokens: 4000, cacheWriteTokens: 0, totalTokens: 9010 },
  },
})
mock.emitPrivateText({ userId: 11001, nickname: '朋友', text: '聊点别的', messageId: 411 })
// 前面白名单那段的「陌生人」消息也会进这个 open 实例，created 里可能多出别的会话，
// 所以按内容找，不按序号找
const gotIt = (agent) => agent.received.some((m) => textOf(m).includes('聊点别的'))
await waitFor(() => created.some(gotIt), { what: '压力超限仍可在原会话继续' })
const swapped = created.find(gotIt)
const swappedText = textOf(swapped.received.find(m => textOf(m).includes('聊点别的')))
assert.match(swappedText, /聊点别的/)
await swapped.whenIdle()
assert.match(swapped.system, /【聊天与工具】/, '新会话应该使用 system 聊天规矩')
assert.equal(swapped, privateAgent, '不按 token 阈值换会话')
assert.doesNotMatch(swappedText, /刚才那段聊到这里/)
console.log('✓ 压力超限仍保留原会话')

// —— 连发合并：一口气发三条，只回一轮 ——
const { ctx: ctx3, created: created3 } = createFakeCtx()
const config3 = Config({
  wsUrl: `ws://127.0.0.1:${PORT}`,
  accessToken: TOKEN,
  privateMode: 'open',
  splitDelayMs: 0,
  replyDelayMeanMs: 0,
  splitDelayMeanMs: 0,
  mergeWindowMs: 300,
})
apply(ctx3, config3)
await waitFor(() => mock.clientCount === 3, { what: '第三个实例连上' })
mock.emitPrivateText({ userId: 77111, nickname: '连发的人', text: '在吗', messageId: 501 })
mock.emitPrivateText({ userId: 77111, nickname: '连发的人', text: '我问你个事', messageId: 502 })
mock.emitPrivateText({ userId: 77111, nickname: '连发的人', text: '就是那个好了没', messageId: 503 })
await sleep(120)
assert.equal(
  created3.some((a) => a.received.length > 0),
  false,
  '还在窗口内，不该急着投递',
)
await sleep(400)
const mergedAgent = created3.find((a) => a.received.length > 0)
assert.ok(mergedAgent, '窗口结束后应该投递一轮')
const mergedText = textOf(mergedAgent.received[0])
assert.match(mergedText, /在吗/, '合并后的正文应该带上第一条')
assert.match(mergedText, /我问你个事/, '合并后的正文应该带上第二条')
assert.match(mergedText, /就是那个好了没/, '合并后的正文应该带上第三条')
assert.equal(mergedAgent.received.length, 1, '三条连发只该投递一轮')
console.log('✓ 连发合并：三条攒成一轮，只回一次')

// —— 通道回执：桥断了，她得知道（不是对方不理她） ——
// 起因：2026-10-26 小黑盒《因为没开桥，被我孤立了16天》——
// 桥断半个月，她一直在发，110 多条一条都没出去，只能猜自己「排到最后了」。
const mock2 = await startMockNapcat({ port: 0, token: TOKEN, selfId: 10003, selfName: '小桥', quiet: true })
await mock2.start()
const PORT2 = mock2.port

const { ctx: ctx4, created: created4 } = createFakeCtx()
const config4 = Config({
  wsUrl: `ws://127.0.0.1:${PORT2}`,
  accessToken: TOKEN,
  privateMode: 'open',
  splitDelayMs: 0,
  replyDelayMeanMs: 0,
  splitDelayMeanMs: 0,
  mergeWindowMs: 0,
  reconnectMs: 300,
})
apply(ctx4, config4)
await waitFor(() => mock2.clientCount === 1, { what: '回执实例连上' })

mock2.emitPrivateText({ userId: 88001, nickname: '小桥的人', text: '第一句', messageId: 601 })
await waitFor(() => created4.length === 1 && created4[0].received.length === 1, { what: '回执实例入站' })
const bridgeAgent = created4[0]

// 桥断了
await mock2.close()
await sleep(300)

// 断线期间她自己说了一句：outbound 自动转发 → 发不出去 → 该记下来
await ctx4.emit('session/event', bridgeAgent.session, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '姐姐，我一直在等你' }] }, usage: {} },
})
// 桥回来了
const mock2b = await startMockNapcat({ port: PORT2, token: TOKEN, selfId: 10003, selfName: '小桥', quiet: true })
await mock2b.start()
await waitFor(() => mock2b.clientCount >= 1, { timeout: 20000, what: '回执实例重连' })

// 再进来一句话：这一轮投递必须把「刚才那句没送出去」摆在她眼前
mock2b.emitPrivateText({ userId: 88001, nickname: '小桥的人', text: '你刚才说什么', messageId: 602 })
await waitFor(() => bridgeAgent.received.length >= 2, { what: '断线后再次投递' })
const bridgeText = textOf(bridgeAgent.received[bridgeAgent.received.length - 1])
assert.match(bridgeText, /\[通道\]/, '断线丢过话，下一轮投递必须告诉她')
assert.match(bridgeText, /没送出去|没能送出去/, '要说清是没送出去（不是没人理）')
assert.match(bridgeText, /我一直在等你/, '要能对上她到底哪句话丢了')
assert.match(bridgeText, /不是对方不理你/, '要点明这是通道的问题，不是对方的态度')
console.log('✓ 通道回执：断线丢过的话，下一轮投递里会告诉她')

await mock2b.close()
await mock.close()
console.log('\n全部通过 🎉')
process.exit(0)
