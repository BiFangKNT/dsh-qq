import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { bedtimeRule } from './prompts.js'
import { createAutomationState } from './automation-state.js'
import { canAccessChat } from './access.js'

/** 可选睡前提醒与休息时段限制；私聊正文由既有持久队列保存。 */
const TICK_MS = 60_000
/**
 * 到点那一分钟没送出去（会话正忙 / 内存里刚好没会话），还能补发多久。
 * 过了这段就不补——半夜一点再去催睡没意义。
 */
const LATE_BED_WINDOW_MIN = 30

/** "23:30" → 1410；写错了给 null（当没设）。 */
export function parseHm(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''))
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

function minutesOf(d) {
  return d.getHours() * 60 + d.getMinutes()
}

/** from <= cur < to；跨零点（00:00-08:00 不跨，但 23:00-08:00 会）也支持。 */
export function inRange(from, to, cur) {
  if (from === null || to === null) return false
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function hmText(at) {
  return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`
}

/** 这句话像不像「我要去睡了」。只认短句，免得把「昨晚那个我没睡着」也算进去。 */
export function looksLikeGoodnight(text, words = []) {
  const s = String(text ?? '').trim()
  if (!s || s.length > 20) return false
  // ⭐ 2026-10-24 修：「睡了嘛鲸鲸?」被当成晚安，直接把会话按到明早。
  //   晚安是「告知」，问句是「问她睡没睡」——差一个问号，方向完全相反。
  if (/[?？]\s*$/.test(s)) return false
  // 带疑问词的也不算（吗/嘛/么/呢 在句末或跟「睡」连用）；「我睡了」「困了」「晚安」不受影响。
  if (/(吗|嘛|么|呢)[\s。.!！~～]*$/.test(s)) return false
  if (/(睡了吗|睡了没|睡着了吗|还没睡|没睡|睡不着|醒着吗)/.test(s)) return false
  if (/(不睡|不想睡|还不困|再玩会|再看会)/.test(s)) return false
  return words.some((w) => w && s.includes(w))
}

export function createSleep({ config, manager, logger, automation = createAutomationState(), clock = Date.now }) {
  const known = new Map(), blocked = new Set(), scheduled = new Set()
  let timer = null, stopped = true
  const identity = record => ({ ...record, selfId: record.selfId ?? manager.selfId ?? config.selfId ?? '' })
  const keyOf = record => automation.keyOf(identity(record))
  const enabled = () => config.sleepMode !== false
  const holdNight = () => config.holdNightMessages === true
  const fromAt = scope => parseHm(config[scope + 'SleepFrom']) ?? parseHm(config.sleepFrom) ?? 0
  const toAt = scope => parseHm(config[scope + 'SleepTo']) ?? parseHm(config.sleepTo) ?? 480
  const version = () => JSON.stringify([config.sleepMode, config.holdNightMessages, config.bedtimeAt,
    config.sleepFrom, config.sleepTo, config.privateSleepFrom, config.privateSleepTo])
  let generation = 0, lastVersion = version()

  function stateOf(record) {
    const key = keyOf(record)
    known.set(key, identity(record))
    if (blocked.has(key)) return null
    try { return automation.get('sleep', identity(record)) ?? { sleeping: false, wakeAt: 0, remindedOn: '' } }
    catch (err) { blocked.add(key); logger.error?.('作息自动处理暂停，记录读取失败:', err.message); return null }
  }
  function save(record, state) {
    try { automation.set('sleep', identity(record), state); return true }
    catch (err) { blocked.add(keyOf(record)); logger.error?.('作息自动处理暂停，记录保存失败:', err.message); return false }
  }
  function sync() {
    const current = version()
    if (current !== lastVersion) { generation++; lastVersion = current }
    if (enabled() && holdNight()) return
    for (const record of known.values()) {
      const state = stateOf(record)
      if (state?.sleeping) save(record, { ...state, sleeping: false, wakeAt: 0 })
    }
  }
  function inSleepWindow(now = new Date(clock()), scope = 'private') {
    return inRange(fromAt(scope), toAt(scope), minutesOf(now))
  }
  function shouldHold(record, now = new Date(clock())) {
    if (!record) return false
    if (!enabled() || !holdNight()) {
      const state = record.scope === 'private' && stateOf(record)
      if (state?.sleeping) save(record, { ...state, sleeping: false, wakeAt: 0 })
      return false
    }
    if (record.scope === 'group') return inSleepWindow(now, 'group')
    const state = stateOf(record)
    if (!state) return true // 记录损坏时保留待交付消息，不猜测休息状态。
    if (state.sleeping && now.getTime() < state.wakeAt) return true
    if (state.sleeping && !save(record, { ...state, sleeping: false, wakeAt: 0 })) return true
    return inSleepWindow(now)
  }
  function noteText(record, text, now = new Date(clock())) {
    if (!enabled() || !holdNight() || record?.scope !== 'private' || inSleepWindow(now)) return false
    const words = String(config.goodnightWords ?? '晚安,睡了,睡觉,去睡,我先睡,困了,睡啦').split(',').map(word => word.trim())
    if (!looksLikeGoodnight(text, words)) return false
    const state = stateOf(record)
    if (!state || (state.sleeping && now.getTime() < state.wakeAt)) return false
    const to = toAt('private'), wake = new Date(now)
    wake.setHours(Math.floor(to / 60), to % 60, 0, 0)
    if (wake.getTime() <= now.getTime()) wake.setDate(wake.getDate() + 1)
    if (wake.getTime() <= clock()) return false
    return save(record, { ...state, sleeping: true, wakeAt: wake.getTime() })
  }
  function reminderDue(record, now) {
    if (!enabled() || record?.scope !== 'private' || !canAccessChat(config, record) || inSleepWindow(now)) return false
    const at = parseHm(config.bedtimeAt)
    if (at === null) return false
    const late = (minutesOf(now) - at + 1440) % 1440
    if (late >= LATE_BED_WINDOW_MIN) return false
    const state = stateOf(record)
    return state && state.remindedOn !== reminderDay(now) && (!state.sleeping || now.getTime() >= state.wakeAt)
  }
  function reminderDay(now) {
    const day = new Date(now)
    if (minutesOf(now) < parseHm(config.bedtimeAt)) day.setDate(day.getDate() - 1)
    return dayKey(day)
  }
  function reserveReminder(record, now) {
    const state = stateOf(record)
    return state && save(record, { ...state, remindedOn: reminderDay(now) })
  }
  function takeLateBedtime(record, now = new Date(clock())) {
    if (scheduled.has(keyOf(record)) || !reminderDue(record, now) || !reserveReminder(record, now)) return ''
    return bedtimeRule(config, { label: record.label, now, clock: hmText(minutesOf(now)) })
  }
  function tick(now = new Date(clock())) {
    if (stopped) return
    sync()
    if (!enabled()) return
    for (const record of manager.list()) {
      const key = keyOf(record)
      if (record.busy > 0 || scheduled.has(key) || !reminderDue(record, now)) continue
      const settings = generation, sessionId = record.sessionId
      scheduled.add(key)
      Promise.resolve(manager.enqueue(record, async () => {
        const at = new Date(clock())
        sync()
        if (stopped || settings !== generation || record.sessionId !== sessionId ||
          !reminderDue(record, at) || !reserveReminder(record, at)) return
        record.agent.followup(createUserMessage({ content: [{ type: 'text', text: bedtimeRule(config,
          { label: record.label, now: at, clock: hmText(minutesOf(at)) }) }],
          source: { kind: 'plugin', plugin: 'dsh-qq', form: 'sleep' } }))
        await record.agent.whenIdle()
        await record.outputQueue
      })).catch(err => logger.warn?.('睡前提醒投递失败:', err.message)).finally(() => scheduled.delete(key))
    }
  }
  function start() {
    if (!stopped) return
    stopped = false
    sync()
    timer = setInterval(() => tick(), TICK_MS)
    timer.unref?.()
  }
  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
  }
  return { start, stop, tick, sync, shouldHold, noteText, takeLateBedtime, inSleepWindow }
}
