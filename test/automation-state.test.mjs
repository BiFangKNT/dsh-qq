import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAutomationState } from '../src/automation-state.js'
import { createWake } from '../src/wake.js'
import { createSleep } from '../src/sleep.js'

const logger = { warn() {}, error() {}, info() {} }
const identity = { selfId: '9', scope: 'private', peerId: '10001' }
function directory(t) {
  const home = mkdtempSync(join(tmpdir(), 'qq-automation-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('主动发言与作息共用文件，身份隔离，换会话仍读取同一份', t => {
  const home = directory(t), store = createAutomationState(home)
  const wake = { dayKey: '2026-11-13', count: 2, misses: 1, lastProactiveAt: 100 }
  const sleep = { sleeping: true, wakeAt: 200, remindedOn: '2026-11-13' }
  store.set('wake', identity, wake)
  store.set('sleep', identity, sleep)
  const after = createAutomationState(home)
  assert.deepEqual(after.get('wake', { ...identity, sessionId: 'new' }), wake)
  assert.deepEqual(after.get('sleep', identity), sleep)
  for (const other of [{ selfId: '8' }, { scope: 'group' }, { peerId: '10002' }]) {
    assert.equal(after.get('wake', { ...identity, ...other }), undefined)
  }
})

test('损坏状态不归零、不覆盖，非法字段也明确失败；写失败不提交内存', t => {
  const home = directory(t), store = createAutomationState(home)
  store.set('sleep', identity, { sleeping: false, wakeAt: 0, remindedOn: '' })
  const dir = join(home, 'automation', readdirSync(join(home, 'automation'))[0])
  const file = join(dir, 'state.json')
  const valid = JSON.parse(readFileSync(file, 'utf8'))
  for (const body of ['broken', JSON.stringify({ ...valid, wake: false }), JSON.stringify({ ...valid, sleep: null })]) {
    writeFileSync(file, body)
    const after = createAutomationState(home)
    assert.throws(() => after.get('wake', identity), /原文件保留/)
    assert.throws(() => after.set('wake', identity, {}), /原文件保留/)
    assert.equal(readFileSync(file, 'utf8'), body)
  }
  writeFileSync(file, JSON.stringify(valid))
  mkdirSync(file + '.tmp')
  const after = createAutomationState(home)
  assert.throws(() => after.set('sleep', identity, { sleeping: true, wakeAt: 10, remindedOn: '' }))
  assert.deepEqual(after.get('sleep', identity), valid.sleep)
})

test('成功发言才扣额度，跨重启/换会话不重置，跨天与其他聊天独立', async t => {
  const home = directory(t)
  let now = new Date(2026, 10, 13, 12).getTime(), sent = 0, wake
  const config = { replyToPrivate: true, proactiveEnabled: true, proactiveSilentMs: 60_000,
    proactiveMaxPerDay: 1, proactiveQuietHours: '' }
  const record = { ...identity, sessionId: 's', label: '测试', busy: 0, lastActive: now - 120_000,
    agent: { followup() { sent++; wake.noteProactiveDelivered(record); wake.noteProactiveDelivered(record) }, whenIdle: async () => {} } }
  const manager = { list: () => [record], enqueue: (_r, task) => task() }
  const boot = () => {
    wake = createWake({ config, manager, logger, automation: createAutomationState(home), clock: () => now })
    wake.start()
    return wake
  }
  boot()
  await wake.tick(); await settle()
  assert.equal(sent, 1)
  wake.forget(record); wake.stop()
  record.sessionId = 'new-session'
  now += 10 * 60_000
  boot()
  await wake.tick(); await settle()
  assert.equal(sent, 1)
  now += 24 * 60 * 60_000
  await wake.tick(); await settle()
  assert.equal(sent, 2)
  record.peerId = '10002'
  await wake.tick(); await settle()
  assert.equal(sent, 3)
  wake.stop()
})

test('主动任务执行前检查关闭/重开、访问权限、会话；普通轮不扣主动额度', async t => {
  const home = directory(t)
  let now = new Date(2026, 10, 13, 12).getTime(), sent = 0, tasks = []
  const config = { replyToPrivate: true, proactiveEnabled: true, proactiveSilentMs: 60_000,
    proactiveMaxPerDay: 1, proactiveQuietHours: '' }
  const record = { ...identity, sessionId: 's', label: '测试', busy: 0, lastActive: now - 120_000,
    agent: { followup() { sent++ }, whenIdle: async () => {} } }
  const store = createAutomationState(home)
  const manager = { list: () => [record], enqueue: (_r, task) => { tasks.push(task); return Promise.resolve() } }
  const wake = createWake({ config, manager, logger, automation: store, clock: () => now })
  t.after(() => wake.stop())
  wake.start()
  await wake.tick()
  wake.noteProactiveDelivered(record)
  assert.equal(store.get('wake', record).count, 0, '尚在前一普通轮时不能扣主动额度')
  config.proactiveEnabled = false; wake.sync()
  config.proactiveEnabled = true; wake.sync()
  await tasks.shift()()
  assert.equal(sent, 0)
  now += 120_000
  await wake.tick()
  config.privateMode = 'disabled'
  await tasks.shift()()
  assert.equal(sent, 0)
  config.privateMode = 'open'
  now += 120_000
  await wake.tick()
  record.sessionId = 'new'
  await tasks.shift()()
  assert.equal(sent, 0)
})

test('坏状态使自动请求暂停，仍保留文件与待交付消息', async t => {
  const home = directory(t), store = createAutomationState(home)
  store.set('sleep', identity, { sleeping: false, wakeAt: 0, remindedOn: '' })
  const file = join(home, 'automation', readdirSync(join(home, 'automation'))[0], 'state.json')
  writeFileSync(file, 'broken')
  const config = { replyToPrivate: true, proactiveEnabled: true, proactiveMaxPerDay: 1,
    sleepMode: true, holdNightMessages: true }
  const record = { ...identity, sessionId: 's', lastActive: 1 }
  const manager = { list: () => [record], enqueue() { assert.fail('坏记录不能自动发言') } }
  const automation = createAutomationState(home)
  const sleep = createSleep({ config, manager, logger, automation })
  assert.equal(sleep.shouldHold(record), true)
  const wake = createWake({ config, manager, logger, automation })
  wake.start()
  await wake.tick()
  wake.stop()
  assert.equal(readFileSync(file, 'utf8'), 'broken')
  config.sleepMode = false
  assert.equal(sleep.shouldHold(record), false)
})
