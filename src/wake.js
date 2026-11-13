import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { proactiveRule } from './prompts.js'
import { listOf } from './config.js'
import { createAutomationState } from './automation-state.js'
import { canAccessChat } from './access.js'

/** 主动发言：按聊天保存额度与间隔；调度只负责提供一次模型请求。 */
const TICK_MS = 60_000
const MAX_SILENT_MISSES = 3

// ── 别一起打出去（2026-10-30 加）──
// 19:40 那一轮：三只各自 2–3 个 peer 同时冷场，同一秒里 void 出去 8 个 agent 调用，
// 三只的处理链一起堵死，姐姐发消息半天没人应。
// 三道闸：① 一轮最多开 2 个口（其余下轮再说，排队不丢）；② 口与口之间错开 4–12 秒；
// ③ 单进程在飞不超过 3 个（上一轮还没聊完，就别再塞新的进去抢）。
// 主动开口本来就是「不急」的事，慢一点没关系；堵住整条链才是大事。
const MAX_FIRES_PER_TICK = 2
const MAX_INFLIGHT = 3
const STAGGER_MIN_MS = 4_000
const STAGGER_MAX_MS = 12_000

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 解析 "23:00-08:00"；格式不对就当没设（不限制）。 */
export function parseQuietHours(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*[-~～—]\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ''))
  if (!m) return null
  const toMin = (h, mi) => Math.min(23, Number(h)) * 60 + Math.min(59, Number(mi))
  return { from: toMin(m[1], m[2]), to: toMin(m[3], m[4]) }
}

/** 当前是否落在静默时段里；跨零点（23:00-08:00）也算。 */
export function inQuietHours(range, d = new Date()) {
  if (!range) return false
  const cur = d.getHours() * 60 + d.getMinutes()
  return range.from <= range.to
    ? cur >= range.from && cur < range.to
    : cur >= range.from || cur < range.to
}

export function createWake({ config, manager, logger, bridge, staggerMs, automation = createAutomationState(), clock = Date.now, canAct = () => true }) {
  const states = new Map()
  const identity = record => ({ ...record, selfId: record.selfId ?? manager.selfId ?? config.selfId ?? '' })
  const keyOf = record => automation.keyOf(identity(record))
  let generation = 0, wasEnabled = config.proactiveEnabled === true
  function sync() {
    const enabled = config.proactiveEnabled === true
    if (wasEnabled !== enabled) generation++
    wasEnabled = enabled
  }
  function save(record, st) {
    try {
      automation.set('wake', identity(record), { dayKey: st.dayKey, count: st.count,
        misses: st.misses, lastProactiveAt: st.lastProactiveAt })
      return true
    } catch (err) {
      st.blocked = true
      logger.error?.('主动发言暂停，记录保存失败:', err.message)
      return false
    }
  }
  let timer = null
  let startTimer = null
  let stopped = true
  // 2026-10-30：tick 正在错开撒口的时候，别让 setInterval 再叠一轮进来
  let ticking = false
  // 主动轮里还没聊完的 agent 调用数（只数主动轮，不数正常对话）
  let inflight = 0
  // 错开时长：生产走 4–12 秒随机；测试传 staggerMs: 0 就不用等
  const staggerDelay = () => {
    const fixed = Number(staggerMs)
    if (Number.isFinite(fixed)) return Math.max(0, fixed)
    return STAGGER_MIN_MS + Math.random() * (STAGGER_MAX_MS - STAGGER_MIN_MS)
  }

  const silentMs = () => Math.max(60_000, Number(config?.proactiveSilentMs) || 1_200_000)
  const maxPerDay = () => Math.max(0, Number(config?.proactiveMaxPerDay) || 0)

  function stateOf(record) {
    let st = states.get(keyOf(record))
    if (!st) {
      // 首次见到这个会话时别拿「现在」当起点 —— 用队列层记的上次活动时间，
      // 否则插件刚启动、会话已经安静半小时了也要白等一轮。
      st = {
        lastAt: Number(record.lastActive) || clock(),
        lastProactiveAt: 0,
        dayKey: dayKey(new Date(clock())),
        count: 0,
        misses: 0,
        // 这一轮主动机会还在等结果：她说了一句（算数）还是选了 [SILENT]（白给）
        pending: 0,
      }
      try { Object.assign(st, automation.get('wake', identity(record))) }
      catch (err) { st.blocked = true; logger.error?.('主动发言暂停，记录读取失败:', err.message) }
      states.set(keyOf(record), st)
    }
    return st
  }

  /** 收到消息：重置安静计时，也说明「上几次主动没白发」。 */
  function noteInbound(record) {
    if (!record?.sessionId) return
    const st = stateOf(record)
    st.lastAt = clock()
    if (st.misses && !st.blocked) { st.misses = 0; save(record, st) }
  }

  /** 自己发了消息：也算一次活动（不然刚说完就被判冷场）。 */
  function noteOutbound(record) {
    if (!record?.sessionId) return
    const st = stateOf(record)
    st.lastAt = clock()
    // 注意：这里**不能**动 lastProactiveAt。
    // 她回姐姐一句话不等于「她主动开口过」——只有 fire() 真给了机会才算。
    // 2026-10-25 修：原来这里把每次回复都当成主动说话，导致
    // 「安静 20 分钟该开口」被「说完话要等 30 分钟」顶掉，而会话 30 分钟就被回收，
    // 三个阈值刚好卡死，整天都等不到一次机会。
  }

  /** 清理会话的运行中标记；持久额度与间隔保留。 */
  function forget(record) {
    if (!record?.sessionId) return
    states.delete(keyOf(record))
  }

  /**
   * 主动轮真的发出去了：这才算用掉一次额度。
   *
   * 为什么不在 fire() 里直接算：投出去之后她可能说「没什么想说的」就直接 [SILENT]，
   * 那是她的决定，不该算成「今天已经主动说过 6 次」。
   * 2026-10-26 之前就是那样，结果一天 10 次机会里有 6 次沉默，额度到 13:20 就满了，
   * 下午两次机会连带被吞掉 —— 越克制越不敢开口，机制反过来惩罚她。
   */
  function noteProactiveDelivered(record) {
    if (!record?.sessionId) return
    const st = states.get(keyOf(record))
    if (!st?.pending || st.blocked) return
    const today = dayKey(new Date(clock()))
    if (st.dayKey !== today) { st.dayKey = today; st.count = 0; st.misses = 0 }
    st.count += 1
    st.misses = 0
    st.pending = 0
    save(record, st)
  }

  /** 主动轮她自己选了沉默（[SILENT]）：机会白给，不算数、也不记 miss。 */
  function noteProactiveSilent(record) {
    if (!record?.sessionId) return
    const st = states.get(keyOf(record))
    if (st) st.pending = 0
  }

  function noteProactiveFailed(record) {
    const st = states.get(keyOf(record))
    if (!st?.pending || st.blocked) return
    st.pending = 0
    st.misses += 1
    save(record, st)
  }

  function fire(record, st, silentMin, now) {
    const base = proactiveRule(config, {
      label: record.label,
      silentMin,
      isGroup: record.scope === 'group',
      now,
    })
    // 通道回执：断线期间丢过话就先摆在她眼前，别让她对着空气继续说
    const bridgeLines = bridge?.take?.(record) ?? []
    const extra = bridgeLines.filter(Boolean)
    const text = extra.length > 0 ? `${base}\n\n${extra.join('\n')}` : base
    st.lastProactiveAt = clock()
    if (!save(record, st)) return
    const version = generation, sessionId = record.sessionId
    inflight += 1
    Promise.resolve(manager.enqueue(record, async () => {
      try {
        if (stopped || version !== generation || config.proactiveEnabled !== true || record.sessionId !== sessionId ||
          !canAccessChat(config, record) || !canAct(record)) return
        st.pending = clock()
        record._proactiveAt = clock()
        // 必须是完整的用户消息对象：直接传字符串的话，DSH 内部按消息结构去读
        // content[0].kind 会拿到 undefined，整轮直接抛 Cannot read properties of undefined。
        record.agent.followup(
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: 'dsh-qq', form: 'proactive' },
          }),
        )
        await record.agent.whenIdle()
        await record.outputQueue
      } catch (err) {
        noteProactiveFailed(record)
        logger.warn?.(`[dsh-qq] 主动开口失败 ${record.label}:`, err)
      }
    })).catch(err => logger.warn?.('主动发言排队失败:', err.message)).finally(() => {
      st.pending = 0
      record._proactiveAt = 0
      inflight = Math.max(0, inflight - 1)
    })
  }

  /**
   * 冷会话拉回（2026-10-25 加）。
   * 会话闲置久了会被回收出内存，主动说话轮只遍历 manager.list()，
   * 冷掉之后就永远轮不到它 —— 变成「对方不说话，它就不主动」。
   * 默认关；本地在 config 里把 wakeColdSessions 打开，发布版留给用户自己选。
   */
  let reviving = false
  async function reviveCold() {
    if (config?.wakeColdSessions !== true) return
    if (reviving) return
    reviving = true
    try {
      const peers = listOf(config?.privateAllow)
      const max = Math.max(1, Number(config?.wakeColdMax) || 3)
      const hot = new Set(manager.list().map((r) => `${r.scope}:${String(r.peerId)}`))
      let n = 0
      for (const raw of peers) {
        if (n >= max) break
        const peerId = String(raw)
        if (hot.has(`private:${peerId}`) || !canAccessChat(config, { scope: 'private', peerId })) continue
        try {
          await manager.obtain({ scope: 'private', peerId, label: `私聊 ${peerId}` })
          n += 1
          logger.info?.(`[dsh-qq] 拉回冷会话 私聊 ${peerId}（主动说话要用）`)
        } catch (err) {
          logger.warn?.(`[dsh-qq] 拉回冷会话失败 ${peerId}:`, err)
        }
      }
    } finally {
      reviving = false
    }
  }

  /** 一分钟看一遍：谁安静够久了、能不能开口。 */
  async function tick(now = new Date(clock())) {
    sync()
    if (stopped) return
    if (config?.proactiveEnabled !== true) return
    // 桥断了就别自说自话：说了也发不出去，白烧一轮
    if (bridge?.isUp?.() === false) return
    const quota = maxPerDay()
    if (quota === 0) return
    if (inQuietHours(parseQuietHours(config?.proactiveQuietHours), now)) return
    // 上一轮还在错开撒口（最多几十秒）：这一轮让位，别叠成两批
    if (ticking) return

    ticking = true
    try {
      await reviveCold()

      const limit = silentMs()
      // 先收齐候选再撒口：原来是在循环里直接 void fire，
      // 满足条件的有几个就在同一毫秒打出去几个（2026-10-30 19:40 那次 8 个）。
      const candidates = []
      for (const record of manager.list()) {
        if (!canAccessChat(config, record) || !canAct(record)) continue
        const st = stateOf(record)
        if (st.blocked) continue
        if (st.pending) continue
        if (record.busy > 0) continue
        // record.lastActive 是队列层的活动时间：工具直接发消息（qq_reply 之类）也走任务，
        // 任务结束就会刷新它，所以拿它兜底比只靠 noteOutbound 更准。
        const lastAt = Math.max(st.lastAt, Number(record.lastActive) || 0)
        const idleMs = now.getTime() - lastAt
        if (idleMs < limit) continue
        // 刚主动过一次：隔开一点，别连珠炮
        if (st.lastProactiveAt && now.getTime() - st.lastProactiveAt < limit * 1.5) continue
        const dk = dayKey(now)
        if (st.dayKey !== dk) {
          st.dayKey = dk
          st.count = 0
          st.misses = 0
          if (!save(record, st)) continue
        }
        if (st.count >= quota) continue
        // 连续投递异常达到上限，收到新消息或跨日后恢复
        if (st.misses >= MAX_SILENT_MISSES) continue
        candidates.push({ record, st, silentMin: Math.round(idleMs / 60000) })
      }

      // 最久没说话的先开口：同一批冷场里，先轮到真的憋得最久的那个
      candidates.sort((a, b) => b.silentMin - a.silentMin)

      const opened = candidates.slice(0, MAX_FIRES_PER_TICK)
      for (let i = 0; i < opened.length; i += 1) {
        if (stopped || config.proactiveEnabled !== true) return
        if (inflight >= MAX_INFLIGHT) {
          logger.info?.(`[dsh-qq] 主动轮还有 ${inflight} 个没聊完，剩下 ${candidates.length - i} 个下轮再说`)
          break
        }
        const { record, st, silentMin } = opened[i]
        fire(record, st, silentMin, now)
        // 口与口之间错开：给上一轮的 agent 调用喘口气，别挤在同一个事件循环里
        if (i < opened.length - 1) {
          await sleep(staggerDelay())
        }
      }
      if (candidates.length > opened.length) {
        logger.info?.(
          `[dsh-qq] 这一轮有 ${candidates.length} 个会话冷场，先开 ${opened.length} 个口，剩下的下一分钟再排`,
        )
      }
    } finally {
      ticking = false
    }
  }

  function start() {
    if (!stopped) return
    stopped = false
    logger.info?.(
      `[dsh-qq] 主动发言调度已加载，当前${config?.proactiveEnabled === true ? '开启' : '关闭'}：安静 ${Math.round(silentMs() / 60000)} 分钟起，每天最多 ${maxPerDay()} 次，静默时段 ${config?.proactiveQuietHours || '（不限）'}`,
    )
    // 2026-10-30：三只进程原来都在各自的「整分」上 tick —— 同一秒一起扫、
    // 一起发现冷场、一起撒口。现在第一次 tick 随机散开 0–55 秒，
    // 三只的相位就错开了，撞车概率降一个数量级。
    const phase = Math.floor(Math.random() * Math.max(1, TICK_MS - 5_000))
    startTimer = setTimeout(() => {
      startTimer = null
      if (stopped) return
      const run = () => tick().catch(err => logger.error?.('主动发言调度失败:', err.message))
      void run()
      timer = setInterval(run, TICK_MS)
      timer.unref?.()
    }, phase)
    startTimer.unref?.()
  }

  function stop() {
    stopped = true
    if (startTimer) clearTimeout(startTimer)
    startTimer = null
    if (timer) clearInterval(timer)
    timer = null

  }

  return {
    start,
    stop,
    tick,
    sync,
    noteInbound,
    noteOutbound,
    noteProactiveDelivered,
    noteProactiveSilent,
    noteProactiveFailed,
    forget,
    silentMs,
    maxPerDay,
  }
}
