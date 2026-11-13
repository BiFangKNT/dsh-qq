import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInbound } from '../src/inbound.js'
import { createAddressClassifier } from '../src/address-classifier.js'
import { migrateGroupSettings, requiresGroupMention } from '../src/group-trigger.js'
import { sanitizeOverrides } from '../src/settings.js'
import { textOf } from './mock-dsh.mjs'

async function harness(t, { config: extra = {}, home = '', answers = [] } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 })
  const config = { groupMode: 'open', privateMode: 'open', replyToPrivate: true, requireMention: true,
    groupMessageIntervalMs: 100, mergeWindowMs: 0, historyLimit: 0, chatLog: false,
    addressClassifierProvider: 'test', addressClassifierModel: 'judge', ...extra }
  const calls = [], delivered = [], sent = [], warnings = [], records = new Map()
  let idle = Promise.resolve(), id = 0, held = false, onFollowup, sendError
  const gate = createAddressClassifier({ config, home, logger: {}, llm: { async *stream(request) {
    calls.push(request)
    yield { type: 'text-delta', index: 0, text: answers.shift() ?? 'yes' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } })
  const manager = { selfId: '9', selfName: '测试机器人', findByPeer: (scope, peerId) => records.get(scope + ':' + peerId),
    async obtain(meta) {
      const key = meta.scope + ':' + meta.peerId
      if (!records.has(key)) records.set(key, { ...meta, sessionId: key, history: [], recent: [], busy: 0,
        queue: Promise.resolve(), agent: { session: { deriveMessages: () => [] },
          followup: message => { delivered.push(message); onFollowup?.(message) }, whenIdle: () => idle } })
      return records.get(key)
    },
    enqueue(record, task) {
      const run = record.queue.then(async () => { record.busy++; try { await task() } finally { record.busy-- } })
      record.queue = run.catch(() => {})
      return run
    },
    async replaceSession(record) { record.sessionId += '-new' },
  }
  const inbound = createInbound({ config, manager, addressClassifier: gate, logger: { warn: (...args) => warnings.push(args) },
    client: { call: async () => ({ sender: { user_id: 9 }, message: '机器人的话' }) },
    sleep: { shouldHold: () => held }, send: async (_record, body) => { sent.push(body); if (sendError) throw sendError } })
  t.after(() => inbound.dispose())
  const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(setImmediate) }
  const tick = async ms => { t.mock.timers.tick(ms); await settle() }
  async function receive(text, atMe = false, extraEvent = {}) {
    await inbound({ post_type: 'message', message_type: 'group', group_id: 70001, self_id: 9, user_id: 10001,
      message_id: ++id, sender: { nickname: '甲' },
      message: [...(atMe ? [{ type: 'at', data: { qq: '9' } }] : []), { type: 'text', data: { text } }], ...extraEvent })
    await settle()
  }
  return { config, calls, delivered, sent, warnings, gate, inbound, manager, records, tick, settle, receive,
    set idle(value) { idle = value }, set held(value) { held = value },
    set onFollowup(value) { onFollowup = value }, set sendError(value) { sendError = value } }
}

test('旧免 @ 名单迁入按群覆盖，显式覆盖优先，退役参数删除', () => {
  const config = migrateGroupSettings({ requireMention: true, groupFree: '70001,70002',
    groupMentionOverrides: { '70002': true }, groupWakeMs: 60000, groupReplyGapMs: 20000 })
  assert.deepEqual(config, { requireMention: true, groupMentionOverrides: { '70001': false, '70002': true } })
  assert.equal(requiresGroupMention(config, 70001), false)
  assert.equal(requiresGroupMention(config, 70002), true)
  assert.equal(requiresGroupMention(config, 70003), true)
  assert.deepEqual(sanitizeOverrides({ groupFree: ['70001'], groupWakeMs: 1 }), { groupMentionOverrides: { '70001': false } })
})

for (const requireMention of [false, true]) {
  for (const addressClassifierEnabled of [false, true]) {
    test('四种组合：必须 @=' + requireMention + '，分类器=' + addressClassifierEnabled, async t => {
      const h = await harness(t, { config: { requireMention, addressClassifierEnabled } })
      await h.receive('普通消息')
      if (!requireMention && addressClassifierEnabled) assert.equal(h.delivered.length, 1)
      else assert.equal(h.delivered.length, 0)
      await h.tick(100)
      assert.equal(h.delivered.length, requireMention ? 0 : 1)
      await h.receive('明确点名', true)
      assert.equal(h.delivered.length, requireMention ? 1 : 2)
      assert.equal(h.calls.length, addressClassifierEnabled ? 2 : 0)
      await h.tick(10000)
      assert.equal(h.delivered.length, requireMention ? 1 : 2, '无新消息不请求')
    })
  }
}

test('必须 @ 是硬限制：旧唤醒规则、引用、分类 yes 均不绕过；@ 仍需 yes', async t => {
  const h = await harness(t, { config: { addressClassifierEnabled: true, groupWakeMs: 60000,
    groupWakeNames: ['测试机器人'], groupWakeKeywords: ['关键词'], groupWakeProbability: 1 },
    answers: ['yes', 'yes', 'yes', 'no', 'yes'] })
  await h.receive('测试机器人你在不在？')
  await h.receive('关键词')
  await h.receive('引用补充', false, { message: [{ type: 'reply', data: { id: '88' } }, { type: 'text', data: { text: '补充' } }] })
  await h.receive('这条拒绝', true)
  assert.equal(h.delivered.length, 0)
  await h.receive('这条放行', true)
  assert.equal(h.delivered.length, 1)
  assert.match(textOf(h.delivered[0]), /关键词/)
  assert.equal(h.delivered[0].source.qqMaySilent, false)
})

test('第一条开始固定等待，不随新消息滑动；@ 提前结束等待', async t => {
  const h = await harness(t, { config: { requireMention: false, historyLimit: 4, ownerIds: ['10001'] } })
  await h.receive('第一条')
  await h.tick(60)
  await h.receive('第二条')
  await h.tick(39)
  assert.equal(h.delivered.length, 0)
  await h.tick(1)
  assert.equal(h.delivered.length, 1)
  assert.match(textOf(h.delivered[0]), /第一条[\s\S]*第二条/)
  assert.match(textOf(h.delivered[0]), /收到消息的时间/)
  assert.ok([...h.records.values()][0].history.every(line => line.includes(' · 授权账号')))
  assert.equal(h.delivered[0].source.qqMaySilent, true)
  await h.receive('第三条')
  await h.tick(20)
  await h.receive('马上看', true)
  assert.equal(h.delivered.length, 2)
  await h.tick(1000)
  assert.equal(h.delivered.length, 2)
})

test('忙时继续合并，处理范围固定，新消息留到下一轮', async t => {
  const h = await harness(t, { config: { requireMention: false } })
  let release
  await h.receive('开始', true)
  const record = [...h.records.values()][0]
  record.busy = 1
  h.idle = new Promise(resolve => { release = resolve })
  assert.equal(h.delivered.length, 1)
  await h.receive('忙时的第一条')
  await h.tick(100)
  await h.receive('忙时的第二条')
  assert.equal(h.delivered.length, 1)
  release(); h.idle = Promise.resolve(); record.busy = 0; await h.settle(); await h.tick(1000)
  assert.equal(h.delivered.length, 2)
  assert.match(textOf(h.delivered[1]), /忙时的第一条[\s\S]*忙时的第二条/)
  await h.receive('后到的消息')
  await h.tick(100)
  assert.equal(h.delivered.length, 3)
  assert.doesNotMatch(textOf(h.delivered[1]), /后到的消息/)
})

test('触发词首条立即处理，也提前结束已有等待；命中仍可沉默', async t => {
  const h = await harness(t, { config: { requireMention: false, groupTriggerWords: ['小助手', '来看看'] } })
  await h.receive('小助手在吗')
  assert.equal(h.delivered.length, 1)
  assert.equal(h.delivered[0].source.qqMaySilent, true)
  await h.receive('先留背景')
  await h.tick(20)
  await h.receive('请来看看这条')
  assert.equal(h.delivered.length, 2)
  assert.match(textOf(h.delivered[1]), /先留背景[\s\S]*请来看看这条/)
  await h.tick(1000)
  assert.equal(h.delivered.length, 2)
})

test('触发词只匹配当前消息文字，不匹配引用、转发、媒体或 @他人昵称', async t => {
  const h = await harness(t, { config: { requireMention: false,
    groupTriggerWords: ['机器人的话', '图片', '小助手', 'hellobot', ''] } })
  await h.receive('引用', false, { message: [
    { type: 'reply', data: { id: '88' } }, { type: 'text', data: { text: '补充说明' } },
  ] })
  await h.receive('转发', false, { message: [{ type: 'forward', data: { id: '88' } }] })
  await h.receive('媒体', false, { message: [{ type: 'image', data: {} }] })
  await h.receive('别人', false, { message: [
    { type: 'at', data: { qq: '7', name: '小助手' } }, { type: 'text', data: { text: '这句说给别人' } },
  ] })
  await h.receive('HelloBot')
  assert.equal(h.delivered.length, 0)
  await h.receive('hellobot')
  assert.equal(h.delivered.length, 1)
})

for (const [requireMention, addressClassifierEnabled, answer] of [[true, false, 'yes'], [true, true, 'yes'], [false, true, 'no']]) {
  test(`触发词不绕过必须 @=${requireMention}、分类器=${addressClassifierEnabled}，判断=${answer}`, async t => {
    const h = await harness(t, { config: { groupTriggerWords: ['小助手'], requireMention, addressClassifierEnabled }, answers: [answer] })
    await h.receive('小助手，这条没有 @')
    await h.tick(1000)
    assert.equal(h.delivered.length, 0)
    assert.equal(h.calls.length, addressClassifierEnabled ? 1 : 0)
  })
}

test('触发词可热更新；模型忙时等待，空闲后仅交付一次', async t => {
  const h = await harness(t, { config: { requireMention: false } })
  await h.receive('小助手')
  const record = [...h.records.values()][0]
  record.busy = 1
  h.config.groupTriggerWords = ['小助手']
  await h.tick(1000)
  assert.equal(h.delivered.length, 0)
  record.busy = 0
  await h.tick(1000)
  assert.equal(h.delivered.length, 1)
  await h.tick(1000)
  assert.equal(h.delivered.length, 1)
})

test('设置改变取消旧等待，按群覆盖生效，命令可换 session，卸载不再投递', async t => {
  const h = await harness(t, { config: { requireMention: false } })
  await h.receive('等待中的消息')
  h.config.requireMention = true
  await h.tick(100)
  assert.equal(h.delivered.length, 0)
  await h.receive('/new', true)
  assert.equal(h.sent.length, 1)
  await h.receive('在新会话处理', true)
  assert.equal(h.delivered.length, 1)
  assert.match(textOf(h.delivered[0]), /等待中的消息/)
  h.config.groupMentionOverrides = { '70001': false }
  await h.receive('即将卸载')
  h.inbound.dispose()
  await h.tick(10000)
  assert.equal(h.delivered.length, 1)
})

test('关闭分类器后保留待交付背景，按当前必须 @ 规则处理', async t => {
  const h = await harness(t, { config: { addressClassifierEnabled: true }, answers: ['no'] })
  await h.receive('分类器跳过的背景')
  h.config.addressClassifierEnabled = false
  await h.receive('没有 @')
  await h.tick(10000)
  assert.equal(h.delivered.length, 0)
  await h.receive('现在回答', true)
  assert.equal(h.delivered.length, 1)
  assert.match(textOf(h.delivered[0]), /分类器跳过的背景/)
  assert.equal(h.calls.length, 1)
})

test('普通等待可持久恢复，重启按当前规则执行，不绑定旧 session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qq-group-trigger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = await harness(t, { home: root, config: { requireMention: false } })
  await h.receive('重启前的消息')
  h.inbound.dispose()
  const restored = createAddressClassifier({ config: h.config, home: root, logger: {} })
  const inbound = createInbound({ config: h.config, manager: h.manager, addressClassifier: restored, logger: {} })
  t.after(() => inbound.dispose())
  h.config.requireMention = true
  await h.tick(1000)
  assert.equal(h.delivered.length, 0)
  h.config.groupMentionOverrides = { '70001': false }
  await h.tick(1000)
  assert.equal(h.delivered.length, 1)
  assert.match(textOf(h.delivered[0]), /重启前的消息/)
})

for (const scope of ['group', 'private']) {
  test(`${scope} 连聊达到上限后等待窗口到期，恢复完整轮数额度`, async t => {
    const h = await harness(t, { config: { botChatEnabled: true, peerBots: ['10001'], peerChatMaxTurns: 2 } })
    const event = { message_type: scope }
    await h.receive('真人开始新话题', true, { ...event, user_id: 20001 })
    await h.receive('机器人第一轮', true, event)
    await h.receive('机器人第二轮', true, event)
    assert.equal(h.delivered.length, 3)
    await h.receive('本窗口已达上限', true, event)
    assert.equal(h.delivered.length, 3)
    await h.tick(31 * 60000)
    assert.equal(h.delivered.length, 4, '过期后的积压成为新窗口第一轮')
    await h.receive('新窗口第二轮', true, event)
    assert.equal(h.delivered.length, 5, '没有沿用旧窗口计数')
    await h.receive('新窗口再次达到上限', true, event)
    assert.equal(h.delivered.length, 5)
  })

  test(`${scope} 单轮超时只提示一次，实际结束前不释放队列或标记完成`, async t => {
    const h = await harness(t, { config: { maxTurnMs: 50 } }), gate = Promise.withResolvers()
    const event = { message_type: scope }
    h.onFollowup = () => { h.idle = gate.promise }
    await h.receive('长时间处理', true, event)
    const record = [...h.records.values()][0], messageId = String(record.lastMessageId)
    const meta = { selfId: '9', scope, peerId: record.peerId }
    assert.equal(record.busy, 1)
    assert.equal(h.gate.store.get(meta, messageId).status, 'admitted')
    await h.tick(49)
    assert.equal(h.sent.length, 0)
    await h.tick(1)
    assert.equal(h.sent.length, 1)
    assert.match(h.sent[0], /仍在继续/)
    await h.receive('排队的下一条', true, event)
    await h.tick(2000)
    assert.equal(h.sent.length, 1, '同一轮不重复通知')
    assert.equal(h.delivered.length, 1)
    assert.equal(record.busy, 1)
    assert.equal(h.gate.store.get(meta, messageId).status, 'admitted')
    record.agent.session.snapshotEvents = () => [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]
    gate.resolve(); await h.settle()
    assert.equal(h.gate.store.get(meta, messageId).status, 'processed')
    await h.tick(1000)
    assert.equal(h.delivered.length, 2, '结束后才交付下一轮')
    assert.equal(record.busy, 0)
    await h.tick(1000)
    assert.equal(h.sent.length, 1, '正常完成的下一轮不遗留提示')
  })
}

test('超时提示发送失败不终止主轮，卸载会清除尚未到期的提示', async t => {
  const h = await harness(t, { config: { maxTurnMs: 50 } }), gate = Promise.withResolvers()
  h.onFollowup = () => { h.idle = gate.promise }
  h.sendError = new Error('模拟通知发送失败')
  await h.receive('第一轮', true)
  await h.tick(50)
  const record = [...h.records.values()][0]
  assert.equal(record.busy, 1)
  assert.ok(h.warnings.some(args => args[0] === '发送单轮超时提示失败：'))
  gate.resolve(); await h.settle()
  assert.equal(record.busy, 0)
  h.sendError = null
  const next = Promise.withResolvers()
  h.onFollowup = () => { h.idle = next.promise }
  await h.receive('卸载前还在处理', true)
  h.inbound.dispose()
  await h.tick(1000)
  assert.equal(h.sent.length, 1)
  next.resolve(); await h.settle()
  assert.equal(record.busy, 0)
})
