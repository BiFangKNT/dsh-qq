import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSleep, parseHm, inRange, looksLikeGoodnight } from '../src/sleep.js'
import { createAutomationState } from '../src/automation-state.js'

const logger = { warn() {}, error() {} }
const configOf = () => ({ replyToPrivate: true, sleepMode: true, holdNightMessages: true,
  bedtimeAt: '23:30', sleepFrom: '00:00', sleepTo: '08:00' })
const recordOf = () => ({ selfId: '9', scope: 'private', peerId: '10001', sessionId: 's',
  busy: 0, label: '测试', agent: { followup() {}, whenIdle: async () => {} } })
const date = (day, hour, min = 0) => new Date(2026, 10, day, hour, min)

test('时间与晚安判断不把疑问、否定或长句当成休息通知', () => {
  assert.equal(parseHm('23:30'), 1410)
  assert.equal(parseHm('25:00'), null)
  assert.equal(parseHm(''), null)
  assert.equal(inRange(1380, 480, 90), true)
  assert.equal(inRange(1380, 480, 480), false)
  for (const text of ['晚安？', '睡了吗', '不想睡', '还没睡']) assert.equal(looksLikeGoodnight(text, ['晚安', '睡了', '睡']), false)
  assert.equal(looksLikeGoodnight('晚安', ['晚安']), true)
})

test('晚安状态跨重启与换会话保留；关闭即解除，旧消息不重新休息', t => {
  const home = mkdtempSync(join(tmpdir(), 'qq-sleep-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let now = date(13, 22).getTime()
  const config = configOf(), record = recordOf()
  const boot = () => createSleep({ config, manager: {}, logger,
    automation: createAutomationState(home), clock: () => now })
  let sleep = boot()
  assert.equal(sleep.noteText(record, '晚安'), true)
  record.sessionId = 'new-session'
  now = date(13, 23).getTime()
  sleep = boot()
  assert.equal(sleep.shouldHold(record), true)
  config.holdNightMessages = false
  sleep.sync()
  assert.equal(sleep.shouldHold(record), false)
  config.holdNightMessages = true
  assert.equal(sleep.shouldHold(record), false)
  now = date(14, 10).getTime()
  assert.equal(sleep.noteText(record, '晚安', date(13, 22)), false)
  assert.equal(sleep.shouldHold(record), false)
})

test('提醒可单独关闭，群聊不提醒，补发只在30分钟内且重启不重复', t => {
  const home = mkdtempSync(join(tmpdir(), 'qq-bedtime-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const config = configOf(), record = recordOf()
  const boot = () => createSleep({ config, manager: {}, logger, automation: createAutomationState(home) })
  const sleep = boot()
  assert.equal(sleep.takeLateBedtime(record, date(13, 23, 29)), '')
  assert.ok(sleep.takeLateBedtime(record, date(13, 23, 30)))
  record.sessionId = 'new-session'
  assert.equal(boot().takeLateBedtime(record, date(13, 23, 31)), '')
  assert.equal(sleep.takeLateBedtime({ ...record, scope: 'group' }, date(13, 23, 31)), '')
  config.bedtimeAt = ''
  assert.equal(sleep.takeLateBedtime({ ...record, peerId: '10002' }, date(13, 23, 31)), '')
  config.bedtimeAt = '23:00'
  assert.equal(sleep.takeLateBedtime({ ...record, peerId: '10002' }, date(13, 23, 30)), '')
})

test('跨午夜补发属于前一天的提醒，不重复；关闭后首次读到的休息状态清除', () => {
  const config = { ...configOf(), bedtimeAt: '23:50', sleepFrom: '01:00' }, record = recordOf()
  const automation = createAutomationState()
  const boot = () => createSleep({ config, manager: {}, logger, automation })
  assert.ok(boot().takeLateBedtime(record, date(13, 23, 55)))
  assert.equal(boot().takeLateBedtime(record, date(14, 0, 5)), '')
  automation.set('sleep', record, { sleeping: true, wakeAt: date(14, 8).getTime(), remindedOn: '' })
  config.sleepMode = false
  const sleep = boot()
  assert.equal(sleep.shouldHold(record, date(13, 23)), false)
  config.sleepMode = true
  assert.equal(sleep.shouldHold(record, date(13, 23)), false)
})

test('排队提醒执行前复查开关、权限、会话；实际结束才释放任务', async t => {
  let now = date(13, 23, 30).getTime(), tasks = [], messages = [], idle
  const config = configOf(), record = recordOf()
  record.agent = { followup: m => messages.push(m), whenIdle: () => new Promise(resolve => { idle = resolve }) }
  const manager = { list: () => [record], enqueue: (_r, fn) => { tasks.push(fn); return Promise.resolve() } }
  const sleep = createSleep({ config, manager, logger, clock: () => now })
  t.after(() => sleep.stop())
  sleep.start()
  sleep.tick()
  config.sleepMode = false
  sleep.sync()
  config.sleepMode = true
  sleep.sync()
  await tasks.shift()()
  assert.equal(messages.length, 0)
  await new Promise(resolve => setImmediate(resolve))
  sleep.tick()
  config.privateMode = 'disabled'
  await tasks.shift()()
  assert.equal(messages.length, 0)
  config.privateMode = 'open'
  await new Promise(resolve => setImmediate(resolve))
  sleep.tick()
  record.sessionId = 'new-session'
  await tasks.shift()()
  assert.equal(messages.length, 0)
  await new Promise(resolve => setImmediate(resolve))
  sleep.tick()
  const done = tasks.shift()()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].source.form, 'sleep')
  let finished = false
  done.then(() => { finished = true })
  now += 60 * 60_000
  sleep.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  assert.equal(tasks.length, 0)
  idle()
  await done
})
