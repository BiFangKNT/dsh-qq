import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAddressClassifier } from '../src/address-classifier.js'
import { createInbound } from '../src/inbound.js'
import { keepBacklog, drainBacklog } from '../src/inbound.js'
import { createMockEnvironment } from './mock-environment.mjs'
import { waitFor, textOf } from './mock-dsh.mjs'

const logger = { warn() {} }
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'qq-classifier-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
function model(...answers) {
  const calls = []
  return { calls, async *stream(options) {
    calls.push(options)
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    yield { type: 'reasoning-delta', index: 0, text: 'CLASSIFIER_PRIVATE_REASONING' }
    yield { type: 'text-delta', index: 1, text: answer ?? 'no' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
}
const configOf = () => ({ addressClassifierEnabled: true, addressClassifierProvider: 'test', addressClassifierModel: 'judge' })
const meta = { selfId: '9', scope: 'group', peerId: '70001', label: '测试群' }
const input = id => ({ id: String(id), meta, body: `正文${id}`, source: { user_id: 10001 }, message: { text: `消息${id}` } })

function inboundHarness(t, gate, extra = {}) {
  const delivered = [], records = new Map()
  const config = { ...configOf(), groupMode: 'open', privateMode: 'open', replyToPrivate: true,
    requireMention: true, groupWakeMs: 0, groupReplyGapMs: 0, mergeWindowMs: 0,
    chatLog: false, historyLimit: 0, ...extra.config }
  const manager = { selfId: '9',
    findByPeer: (scope, peerId) => records.get(`${scope}:${peerId}`),
    async obtain(meta) {
      const key = `${meta.scope}:${meta.peerId}`
      if (!records.has(key)) records.set(key, { ...meta, sessionId: key, queue: Promise.resolve(),
        recent: [], history: [], initialContextDelivered: true, agent: {
          session: { deriveMessages: () => [] },
          followup: m => delivered.push(m), whenIdle: async () => {},
        } })
      return records.get(key)
    },
    enqueue(record, task) {
      record.queue = record.queue.then(async () => {
        record.busy = (record.busy ?? 0) + 1
        try { return await task() } finally { record.busy-- }
      })
      return record.queue
    },
  }
  const inbound = createInbound({ config, manager, addressClassifier: gate, logger,
    client: { call: async () => ({}) }, sleep: extra.sleep, approval: extra.approval, questions: extra.questions,
    contextGuard: extra.contextGuard })
  t.after(() => inbound.dispose())
  const event = (id, text = `消息${id}`) => ({ post_type: 'message', message_type: 'group',
    self_id: 9, group_id: 70001, user_id: 10001, message_id: id, message: text,
    sender: { nickname: '甲', user_id: 10001 } })
  return { inbound, delivered, manager, event, config }
}

test('no/no/yes 完整交付，超过30条不截断，重复事件不重复分类', async t => {
  const home = await directory(t), llm = model(...Array(35).fill('no'), 'yes')
  const gate = createAddressClassifier({ home, config: configOf(), llm, logger })
  t.after(() => gate.stop())
  const deliveries = []
  const deliver = async batch => { deliveries.push(batch); return true }
  await Promise.all(Array.from({ length: 36 }, (_, i) => gate.accept(input(i), deliver)))
  await gate.accept(input(35), deliver)
  assert.equal(llm.calls.length, 36)
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].length, 36)
  assert.deepEqual(deliveries[0].map(p => p.id), Array.from({ length: 36 }, (_, i) => String(i)))
  assert.equal(gate.hasPending(), false)
  assert.equal(llm.calls[0].reasoningEffort, 'low')
  assert.deepEqual(llm.calls[0].tools, [])
  assert.equal(llm.calls.at(-1).messages.length, 1)
  assert.equal(JSON.parse(textOf(llm.calls.at(-1).messages[0])).pendingMessages.length, 35)
})

test('失败不是no；交付异常、重启和开关切换不丢待交付消息', async t => {
  const home = await directory(t), config = configOf(), llm = model(new Error('网络错误'), 'yes')
  let gate = createAddressClassifier({ home, config, llm, logger })
  await gate.accept(input(1), async () => { throw new Error('不应交付') })
  await assert.rejects(gate.accept(input(2), async () => { throw new Error('主会话拒绝') }), /主会话拒绝/)
  const files = await readdir(join(home, 'address-classifier'))
  const saved = JSON.parse(await readFile(join(home, 'address-classifier', files.find(f => f.endsWith('.json'))), 'utf8'))
  assert.equal(saved.pending[0].decision, null)
  assert.match(saved.pending[0].error, /网络错误/)
  gate.stop()
  gate = createAddressClassifier({ home, config, llm, logger })
  t.after(() => gate.stop())
  let count = 0
  config.addressClassifierEnabled = false
  await gate.resume(meta, async () => { count++; return true })
  assert.equal(count, 0)
  config.addressClassifierEnabled = true
  await gate.resume(meta, async batch => { count++; assert.equal(batch.length, 2); return true })
  assert.equal(count, 1)
  assert.equal(llm.calls.length, 2)
  assert.equal(gate.hasPending(), false)
})

test('不同会话独立，无法识别后重试，旧消息不会被另一会话放行', async t => {
  const home = await directory(t), llm = model('unrecognized', 'no', 'yes', 'no'), config = configOf()
  const gate = createAddressClassifier({ home, config, llm, logger })
  t.after(() => gate.stop())
  await gate.accept(input(1), async () => { throw new Error('不应交付') })
  await gate.accept({ ...input(2), meta: { ...meta, scope: 'private' } }, async batch => {
    assert.deepEqual(batch.map(p => p.id), ['2']); return true
  })
  await gate.accept(input(3), async () => { throw new Error('不应交付') })
  assert.notEqual(llm.calls[0].sessionId, llm.calls[2].sessionId)
  assert.equal(JSON.parse(textOf(llm.calls[2].messages[0])).pendingMessages.length, 0)
  assert.equal(gate.hasPending(), true)
})

test('严格结果直接采用；正则提取完整单词，忽略推理并拒绝矛盾结果', async t => {
  const home = await directory(t), llm = model(' NO ', '```json\n{"answer":"yes"}\n```', 'yes or no', 'The answer is no.')
  const gate = createAddressClassifier({ home, config: configOf(), llm, logger })
  t.after(() => gate.stop())
  const deliveries = []
  const deliver = async batch => { deliveries.push(batch); return true }
  await gate.accept(input(1), deliver)
  assert.equal(llm.calls.length, 1)
  assert.equal(deliveries.length, 0)
  await gate.accept(input(2), deliver)
  assert.equal(llm.calls.length, 2)
  assert.deepEqual(deliveries[0].map(item => item.id), ['1', '2'])
  assert.deepEqual(deliveries[0][1].classification, { method: 'regex', attempts: 1 })
  await gate.accept(input(3), deliver)
  assert.equal(llm.calls.length, 4)
  assert.equal(deliveries.length, 1)
  const files = await readdir(join(home, 'address-classifier'))
  const saved = JSON.parse(await readFile(join(home, 'address-classifier', files.find(f => f.endsWith('.json'))), 'utf8'))
  assert.equal(saved.pending[0].decision, 'no')
  assert.deepEqual(saved.pending[0].classification, { method: 'regex', attempts: 2 })
  assert.equal(llm.calls[2].messages.length, 1)
  assert.equal(JSON.parse(textOf(llm.calls[3].messages[0])).current.text, '消息3')
})

test('最多重试两次，第三次仍无法识别则yes，并记录可定位的兜底日志', async t => {
  const home = await directory(t), llm = model('nobody', 'yesterday', 'PRIVATE_CLASSIFIER_RESPONSE', 'no'), warnings = []
  const gate = createAddressClassifier({ home, config: configOf(), llm,
    logger: { warn: (...args) => warnings.push(args) } })
  t.after(() => gate.stop())
  let count = 0
  await gate.accept(input(1), async batch => {
    count++
    assert.equal(batch[0].decision, 'yes')
    assert.deepEqual(batch[0].classification, { method: 'fallback', attempts: 3 })
    return false
  })
  assert.equal(count, 1)
  assert.equal(llm.calls.length, 3)
  const fallback = warnings.filter(([message]) => message.includes('fallback_yes'))
  assert.equal(fallback.length, 1)
  assert.deepEqual(fallback[0][1], { sessionId: llm.calls[0].sessionId,
    scope: meta.scope, peerId: meta.peerId, messageId: '1', provider: 'test', model: 'judge',
    attempts: 3, reason: 'unrecognized_response', decision: 'yes' })
  assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE_CLASSIFIER_RESPONSE|CLASSIFIER_PRIVATE_REASONING/)
  const files = await readdir(join(home, 'address-classifier'))
  const saved = JSON.parse(await readFile(join(home, 'address-classifier', files.find(f => f.endsWith('.json'))), 'utf8'))
  assert.deepEqual(saved.pending[0].classification, { method: 'fallback', attempts: 3 })
})

test('第三次请求识别成功采用真实结果，不记录兜底', async t => {
  const home = await directory(t), llm = model('unknown', '', 'no'), warnings = []
  const gate = createAddressClassifier({ home, config: configOf(), llm,
    logger: { warn: (...args) => warnings.push(args) } })
  t.after(() => gate.stop())
  await gate.accept(input(1), async () => { throw new Error('不应交付') })
  assert.equal(llm.calls.length, 3)
  assert.equal(warnings.filter(([message]) => message.includes('fallback_yes')).length, 0)
  assert.equal(gate.hasPending(), true)
})

test('兜底通过现有日志器落盘，关闭功能不会触发兜底放行', async t => {
  const root = await directory(t), llm = model('unknown', 'unknown', 'unknown')
  const env = await createMockEnvironment({ root, llm, autoReply: false, config: configOf() })
  t.after(() => env.close())
  env.emitMessage({ scope: 'group', peerId: 72002, text: '测试兜底放行', messageId: 12345 })
  await waitFor(() => env.snapshot().sessions.some(s => s.received.length === 1))
  const logDir = join(root, '会话', 'logs')
  const files = await readdir(logDir)
  const logs = (await Promise.all(files.map(file => readFile(join(logDir, file), 'utf8')))).join('\n')
  assert.match(logs, /\[warn\].*fallback_yes/)
  assert.match(logs, /"messageId":"12345"/)
  assert.match(logs, /"attempts":3/)
  assert.equal(llm.calls.length, 3)
  const home = await directory(t), config = configOf()
  const disabled = { calls: 0, async *stream() {
    this.calls++
    config.addressClassifierEnabled = false
    yield { type: 'text-delta', index: 0, text: 'unknown' }
  } }
  const gate = createAddressClassifier({ home, config, llm: disabled, logger })
  t.after(() => gate.stop())
  await gate.accept(input(1), async () => { throw new Error('不应交付') })
  assert.equal(disabled.calls, 1)
  assert.equal(gate.hasPending(), true)
})

test('完整消息入口：替代无@规则、保留媒体与来源、隔离判断过程、访问控制优先', async t => {
  const root = await directory(t), llm = model('no', 'no', 'yes')
  const env = await createMockEnvironment({ root, llm, autoReply: false, config: { ...configOf(), debug: true } })
  t.after(() => env.close())
  env.emitMessage({ scope: 'group', peerId: 72001, text: '第一条背景', messageId: 1, image: true })
  env.emitMessage({ scope: 'group', peerId: 72001, text: '第二条背景', messageId: 2 })
  env.emitMessage({ scope: 'group', peerId: 72001, text: '机器人请看前面的图片', messageId: 3 })
  await waitFor(() => env.snapshot().sessions.some(s => s.received.length === 1))
  assert.equal(llm.calls.length, 3)
  const session = env.snapshot().sessions.find(s => s.received.length)
  const body = textOf(session.received[0])
  assert.match(body, /第一条背景/)
  assert.match(body, /第二条背景/)
  assert.match(body, /机器人请看前面的图片/)
  assert.match(body, /qq-.*\.png/)
  assert.doesNotMatch(body, /CLASSIFIER_PRIVATE_REASONING|只输出 yes 或 no/)
  assert.equal(env.snapshot().sessions.length, 1)
  env.config.groupMode = 'disabled'
  env.emitMessage({ scope: 'group', peerId: 72001, text: '不应分类', messageId: 4 })
  await waitFor(() => env.snapshot().logs.some(l => l.text.includes('未授权')))
  assert.equal(llm.calls.length, 3)
})

test('睡眠中的完整消息重启后交付，关闭开关不会偷偷恢复旧消息', async t => {
  const home = await directory(t), config = configOf(), llm = model('no', 'yes')
  const gate = createAddressClassifier({ home, config, llm, logger })
  const sleeping = inboundHarness(t, gate, { sleep: { shouldHold: () => true } })
  await sleeping.inbound(sleeping.event(1))
  await sleeping.inbound(sleeping.event(2))
  assert.equal(sleeping.delivered.length, 0)
  sleeping.inbound.dispose()
  const restored = createAddressClassifier({ home, config, llm, logger })
  const awake = inboundHarness(t, restored)
  awake.config.addressClassifierEnabled = false
  await new Promise(resolve => setTimeout(resolve, 1050))
  assert.equal(awake.delivered.length, 0)
  awake.config.addressClassifierEnabled = true
  await waitFor(() => awake.delivered.length === 1)
  assert.match(textOf(awake.delivered[0]), /消息1/)
  assert.match(textOf(awake.delivered[0]), /消息2/)
  assert.equal(llm.calls.length, 2)
  assert.equal(restored.hasPending(), false)
})

test('审批回答不等待分类，关闭后恢复旧触发，未授权与同类开关不被绕过', async t => {
  const home = await directory(t), config = configOf()
  let unblock
  const llm = { calls: 0, async *stream() {
    this.calls++
    await new Promise(resolve => { unblock = resolve })
    yield { type: 'text-delta', index: 0, text: 'no' }
  } }
  const gate = createAddressClassifier({ home, config, llm, logger })
  let approved = 0
  const h = inboundHarness(t, gate, { approval: { tryResolve: (_r, text) => {
    if (text !== '批准') return false
    approved++; return true
  } } })
  const pending = h.inbound(h.event(1))
  await waitFor(() => typeof unblock === 'function')
  await h.inbound(h.event(2, '批准'))
  assert.equal(approved, 1)
  await h.inbound(h.event(2, '批准'))
  assert.equal(approved, 1)
  assert.equal(llm.calls, 1)
  unblock()
  await pending
  h.config.addressClassifierEnabled = false
  await h.inbound(h.event(3))
  assert.equal(h.delivered.length, 0)
  await h.inbound(h.event(4, [{ type: 'at', data: { qq: '9' } }, { type: 'text', data: { text: '你好' } }]))
  assert.equal(h.delivered.length, 1)
  h.config.addressClassifierEnabled = true
  h.config.peerBots = ['10001']
  await h.inbound(h.event(5))
  h.config.groupMode = 'disabled'
  await h.inbound(h.event(6))
  assert.equal(llm.calls, 1)
})

test('主模型繁忙不阻塞逐消息分类，空闲后按顺序补齐', async t => {
  const home = await directory(t), llm = model('yes', 'no', 'yes')
  const gate = createAddressClassifier({ home, config: configOf(), llm, logger })
  const h = inboundHarness(t, gate)
  const record = await h.manager.obtain(meta)
  let finish
  record.agent.whenIdle = () => new Promise(resolve => { finish = resolve })
  await h.inbound(h.event(1))
  await h.inbound(h.event(2))
  await h.inbound(h.event(3))
  assert.equal(llm.calls.length, 3)
  assert.equal(h.delivered.length, 1)
  record.agent.whenIdle = async () => {}
  finish()
  await waitFor(() => h.delivered.length === 2)
  assert.match(textOf(h.delivered[1]), /消息2/)
  assert.match(textOf(h.delivered[1]), /消息3/)
  assert.doesNotMatch(textOf(h.delivered[1]), /消息1/)
})

test('分类超时和卸载都会取消请求，消息保留等待后续放行', async t => {
  const home = await directory(t), config = { ...configOf(), addressClassifierTimeoutMs: 10 }
  let signal
  const llm = { async *stream(options) {
    signal = options.signal
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  } }
  const gate = createAddressClassifier({ home, config, llm, logger })
  await gate.accept(input(1), async () => { throw new Error('不应交付') })
  assert.equal(signal.aborted, true)
  config.addressClassifierTimeoutMs = 30000
  const pending = gate.accept(input(2), async () => { throw new Error('不应交付') })
  await waitFor(() => signal && !signal.aborted)
  gate.stop()
  await pending
  assert.equal(signal.aborted, true)
  assert.equal(gate.hasPending(), true)
})

test('关闭功能不读取旧分类记录，坏记录不被覆盖或破坏正常聊天', async t => {
  const home = await directory(t), dir = join(home, 'address-classifier')
  await mkdir(dir)
  await writeFile(join(dir, 'broken.json'), 'broken')
  const config = { ...configOf(), addressClassifierEnabled: false }, warnings = []
  const gate = createAddressClassifier({ home, config, logger: { warn: text => warnings.push(text) } })
  t.after(() => gate.stop())
  assert.deepEqual(gate.list(), [])
  assert.equal(warnings.length, 0)
  config.addressClassifierEnabled = true
  assert.deepEqual(gate.list(), [])
  assert.match(warnings[0], /原文件保留/)
  assert.equal(await readFile(join(dir, 'broken.json'), 'utf8'), 'broken')
})

test('等待上一条判断时先保存新源事件，重启后完整恢复尚未准备的消息', async t => {
  const home = await directory(t), config = configOf()
  let started = false
  const stalled = { async *stream(options) {
    started = true
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  } }
  const gate = createAddressClassifier({ home, config, llm: stalled, logger })
  const h = inboundHarness(t, gate)
  const first = h.inbound(h.event(1))
  await waitFor(() => started)
  const second = h.inbound(h.event(2)), third = h.inbound(h.event(3))
  assert.deepEqual(gate.unprepared().map(item => item.id), ['2', '3'])
  h.inbound.dispose()
  await Promise.all([first, second, third])
  const llm = model('no', 'yes'), restored = createAddressClassifier({ home, config, llm, logger })
  const recovered = inboundHarness(t, restored)
  await waitFor(() => recovered.delivered.length === 1)
  assert.equal(llm.calls.length, 2)
  const text = textOf(recovered.delivered[0])
  assert.ok(text.indexOf('消息1') < text.indexOf('消息2'))
  assert.ok(text.indexOf('消息2') < text.indexOf('消息3'))
  assert.deepEqual(restored.unprepared(), [])
  assert.equal(restored.hasPending(), false)
})

test('判断过程中关闭开关，已排队的旧消息暂停，新的消息走原流程', async t => {
  const home = await directory(t), config = configOf()
  let complete
  const llm = { async *stream() {
    await new Promise(resolve => { complete = resolve })
    yield { type: 'text-delta', index: 0, text: 'yes' }
  } }
  const gate = createAddressClassifier({ home, config, llm, logger })
  const h = inboundHarness(t, gate, { config: { requireMention: false } })
  const first = h.inbound(h.event(1))
  await waitFor(() => typeof complete === 'function')
  const second = h.inbound(h.event(2))
  config.addressClassifierEnabled = h.config.addressClassifierEnabled = false
  complete()
  await Promise.all([first, second])
  assert.equal(h.delivered.length, 0)
  await h.inbound(h.event(3))
  assert.equal(h.delivered.length, 1)
  assert.match(textOf(h.delivered[0]), /消息3/)
  config.addressClassifierEnabled = true
  assert.deepEqual(gate.unprepared().map(item => item.id), ['2'])
  assert.equal(gate.hasPending(), true)
})

test('重启后先收到新消息，也先恢复同聊天中的旧源事件', async t => {
  const home = await directory(t), config = configOf(), llm = model('no', 'yes')
  const gate = createAddressClassifier({ home, config, llm, logger })
  const h = inboundHarness(t, gate)
  gate.stage({ meta, id: '1', source: h.event(1) })
  await h.inbound(h.event(2))
  assert.equal(h.delivered.length, 1)
  assert.deepEqual(llm.calls.map(call => JSON.parse(textOf(call.messages[0])).current.text), ['消息1', '消息2'])
  assert.match(textOf(h.delivered[0]), /消息1[\s\S]*消息2/)
})

test('共用原图片缓存：重启和关闭期间不误删待交付附件，交付后正常清理', async t => {
  const home = await directory(t), cacheDir = join(home, '图片缓存'), config = configOf()
  await mkdir(cacheDir)
  const paths = Array.from({ length: 201 }, (_, i) => join(cacheDir, `qq-old-${String(i).padStart(3, '0')}.png`))
  await Promise.all(paths.map(path => writeFile(path, 'fixture')))
  const gate = createAddressClassifier({ home, config, llm: model('no'), logger })
  await gate.accept({ ...input(1), attachmentPaths: paths }, async () => { throw new Error('不应交付') })
  gate.stop()
  config.addressClassifierEnabled = false
  const restored = createAddressClassifier({ home, config, logger })
  const h = inboundHarness(t, restored, { config: {
    addressClassifierEnabled: false, requireMention: false, imageCacheDir: cacheDir,
  } })
  const image = [{ type: 'image', data: { url: 'base64://aW1hZ2U=' } }]
  await h.inbound(h.event(2, image))
  assert.equal((await readdir(cacheDir)).length, 202)
  assert.deepEqual(restored.pendingAttachmentPaths(), new Set(paths))
  const delivered = textOf(h.delivered[0])
  assert.ok(delivered.includes(cacheDir))
  assert.doesNotMatch(delivered, /分类消息附件/)
  config.addressClassifierEnabled = true
  // no 消息仍未放行；下一条 yes 将这些附件一起交给主模型。
  const next = createAddressClassifier({ home, config, llm: model('yes'), logger })
  await next.accept(input(3), async () => true)
  next.stop()
  restored.stop()
  const afterDelivery = createAddressClassifier({ home, config, logger })
  const normal = inboundHarness(t, afterDelivery, { config: {
    addressClassifierEnabled: false, requireMention: false, imageCacheDir: cacheDir,
  } })
  assert.equal(afterDelivery.pendingAttachmentPaths().size, 0)
  await normal.inbound(normal.event(4, image))
  const names = await readdir(cacheDir)
  assert.equal(names.length, 200)
  assert.ok(names.filter(name => name.startsWith('qq-old-')).length < paths.length)
})

test('放行后本轮尚未结束时，旧消息里的图片仍可读取', async t => {
  const home = await directory(t), cacheDir = join(home, '图片缓存'), config = configOf()
  await mkdir(cacheDir)
  const paths = Array.from({ length: 201 }, (_, i) => join(cacheDir, `qq-old-${i}.png`))
  await Promise.all(paths.map(path => writeFile(path, 'fixture')))
  const gate = createAddressClassifier({ home, config, llm: model('no', 'yes'), logger })
  await gate.accept({ ...input(1), attachmentPaths: paths }, async () => false)
  const h = inboundHarness(t, gate, { config: { imageCacheDir: cacheDir } })
  const record = await h.manager.obtain(meta)
  let finish
  const idle = new Promise(resolve => { finish = resolve })
  t.after(() => finish())
  record.agent.whenIdle = () => idle
  const image = [{ type: 'image', data: { url: 'base64://aW1hZ2U=' } }]
  await h.inbound(h.event(2, image))
  assert.equal(h.delivered.length, 1)
  assert.equal(gate.hasPending(), false)
  assert.equal((await readdir(cacheDir)).length, 202)
  finish()
  await record.queue
  h.config.addressClassifierEnabled = false
  h.config.requireMention = false
  await h.inbound(h.event(3, image))
  assert.equal((await readdir(cacheDir)).length, 200)
})

test('审批和问答快速通道保留同类机器人开关，群聊与私聊均有效', async t => {
  for (const scope of ['group', 'private']) {
    for (const detection of ['list', 'metadata']) {
      const home = await directory(t), config = configOf(), llm = model(), resolved = []
      const gate = createAddressClassifier({ home, config, llm, logger })
      const h = inboundHarness(t, gate, { config: { botChatEnabled: false,
        peerBots: detection === 'list' ? ['10001'] : [] },
        approval: { tryResolve: (_record, text) => { if (text !== '批准') return false; resolved.push(text); return true } },
        questions: { tryResolve: (_record, text) => { if (text !== '回答') return false; resolved.push(text); return true } },
      })
      const peerId = scope === 'group' ? '70091' : '10001'
      await h.manager.obtain({ ...meta, scope, peerId })
      const event = (id, text) => ({ ...h.event(id, text), message_type: scope, group_id: peerId,
        sender: { nickname: '其他机器人', user_id: 10001, ...(detection === 'metadata' ? { is_robot: true } : {}) } })
      await h.inbound(event(1, '批准'))
      await h.inbound(event(2, '回答'))
      assert.deepEqual(resolved, [])
      assert.equal(llm.calls.length, 0)
      h.config.botChatEnabled = true
      await h.inbound(event(3, '批准'))
      await h.inbound(event(4, '回答'))
      assert.deepEqual(resolved, ['批准', '回答'])
      assert.equal(llm.calls.length, 0)
      drainBacklog(peerId)
    }
  }
})

test('no 不修改主会话；正式轮不再交付旧便签', async t => {
  const home = await directory(t), config = configOf(), llm = model('no')
  let swaps = 0, marked = 0
  const gate = createAddressClassifier({ home, config, llm, logger })
  const h = inboundHarness(t, gate, { config: { persona: '测试人设_首轮必须存在', requireMention: false, historyLimit: 5 },
    contextGuard: { maybeSwap: async () => { swaps++; return null } } })
  const record = await h.manager.obtain(meta)
  record.initialContextDelivered = false
  record.swapSeed = ['保留交接内容']
  h.manager.markInitialContextDelivered = r => { marked++; r.initialContextDelivered = true }
  keepBacklog(meta.peerId, '此前没有回应的群背景')
  const previous = structuredClone({ recent: record.recent, history: record.history,
    swapSeed: record.swapSeed, lastSenderId: record.lastSenderId })
  await h.inbound(h.event(801))
  assert.equal(record.initialContextDelivered, false)
  assert.equal(marked, 0)
  assert.equal(swaps, 0)
  assert.deepEqual({ recent: record.recent, history: record.history,
    swapSeed: record.swapSeed, lastSenderId: record.lastSenderId }, previous)
  assert.match(JSON.stringify(llm.calls[0].messages), /此前没有回应的群背景/)
  h.config.addressClassifierEnabled = false
  await h.inbound(h.event(802))
  await record.queue
  assert.equal(h.delivered.length, 1)
  const body = textOf(h.delivered[0])
  assert.doesNotMatch(body, /测试人设_首轮必须存在/)
  assert.doesNotMatch(body, /保留交接内容/)
  assert.match(body, /此前没有回应的群背景/)
  assert.equal(record.initialContextDelivered, false)
  assert.equal(marked, 0)
})

test('yes 投递失败保留待处理消息，成功后不恢复旧便签', async t => {
  const home = await directory(t), config = configOf(), llm = model('no', 'yes', 'yes')
  const gate = createAddressClassifier({ home, config, llm, logger })
  const h = inboundHarness(t, gate, { config: { persona: '测试人设_不得重复注入' } })
  const record = await h.manager.obtain(meta)
  record.initialContextDelivered = false
  record.swapSeed = ['未交付的交接']
  await h.inbound(h.event(901))
  assert.equal(record.initialContextDelivered, false)
  const followup = record.agent.followup
  record.agent.followup = () => { throw new Error('投递拒绝') }
  await assert.rejects(h.inbound(h.event(902)), /投递拒绝/)
  assert.equal(record.initialContextDelivered, false)
  assert.deepEqual(record.swapSeed, ['未交付的交接'])
  record.agent.followup = followup
  await gate.resume(meta, async () => false)
  await h.inbound(h.event(903))
  assert.equal(h.delivered.length, 1)
  assert.equal(record.initialContextDelivered, false)
  assert.deepEqual(record.swapSeed, ['未交付的交接'])
  const body = textOf(h.delivered[0])
  assert.doesNotMatch(body, /测试人设_不得重复注入/)
  assert.doesNotMatch(body, /未交付的交接/)
  assert.match(body, /消息901[\s\S]*消息902[\s\S]*消息903/)
})

test('分类只读完整主会话和全部待处理消息，压缩后读取当前内容且私聊互不串入', async t => {
  const home = await directory(t), config = configOf(), llm = model('no', 'no', 'no', 'no')
  const gate = createAddressClassifier({ home, config, llm, logger })
  const h = inboundHarness(t, gate)
  const record = await h.manager.obtain(meta)
  let messages = Object.freeze(Array.from({ length: 65 }, (_, i) => Object.freeze({
    role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `完整历史${i}` }],
  })))
  const header = Object.freeze({ system: '主会话系统提示_仅作为背景', tools: [{ name: '主会话工具_不可执行' }] })
  record.agent.session.deriveMessages = () => messages
  record.agent.session.requestHeader = () => header
  h.manager.runtimeContext = () => '最新有效事项_只读'
  const before = JSON.stringify({ messages, header })
  await h.inbound(h.event(1001))
  const first = JSON.parse(textOf(llm.calls[0].messages[0]))
  assert.equal(first.mainContext.messages.length, 65)
  assert.equal(first.mainContext.runtimeContext, '最新有效事项_只读')
  assert.deepEqual(first.mainContext.header, header)
  assert.equal(JSON.stringify({ messages, header }), before)
  assert.deepEqual(llm.calls[0].tools, [])
  assert.doesNotMatch(llm.calls[0].system, /主会话系统提示_仅作为背景/)
  await h.inbound(h.event(1002))
  const second = JSON.parse(textOf(llm.calls[1].messages[0]))
  assert.deepEqual(second.pendingMessages.map(item => item.id), ['1001'])
  messages = Object.freeze([{ role: 'user', content: [{ type: 'text', text: 'DSH压缩后的摘要' }] }])
  await h.inbound(h.event(1003))
  const third = JSON.parse(textOf(llm.calls[2].messages[0]))
  assert.deepEqual(third.mainContext.messages, messages)
  assert.doesNotMatch(JSON.stringify(third.mainContext), /完整历史0/)
  assert.deepEqual(third.pendingMessages.map(item => item.id), ['1001', '1002'])
  await h.inbound({ ...h.event(1004), message_type: 'private', user_id: 10002 })
  const other = JSON.parse(textOf(llm.calls[3].messages[0]))
  assert.deepEqual(other.mainContext.messages, [])
  assert.deepEqual(other.pendingMessages, [])
  assert.doesNotMatch(JSON.stringify(other), /完整历史|DSH压缩后的摘要|消息1001/)
  assert.equal(h.delivered.length, 0)
})
