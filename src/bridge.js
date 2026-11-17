/**
 * 通道回执：暂存发送异常，在下一轮输入中提供明确拒绝、未发送或未确认状态。
 * 未确认可能已送达，不自动重发，也不据此推断对方是否收到或回应。
 * 关闭：config.bridgeReceipt = false（默认开）。
 */

const MAX_FAILS = 4 // 一次最多展示的异常记录数
const SNIP = 60 // 每句留多长
// 超过队列上限的记录保留总数，展示仍只列前 MAX_FAILS 条。
const MAX_QUEUE = 32

function snip(text) {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > SNIP ? `${t.slice(0, SNIP)}…` : t
}

export function humanSpan(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h} 小时 ${rm} 分钟` : `${h} 小时`
}

export function createBridge({ config, logger, manager }) {
  const enabled = () => config?.bridgeReceipt !== false
  // 启动时当作通的：第一次连上不算「恢复」，只有断过再连上才算。
  let up = true
  let downSince = 0

  function push(record, note) {
    if (!record) return
    if (!Array.isArray(record.bridgeNotes)) record.bridgeNotes = []
    record.bridgeNotes.push(note)
    if (record.bridgeNotes.length > MAX_QUEUE) {
      const cut = record.bridgeNotes.splice(0, record.bridgeNotes.length - MAX_QUEUE)
      const lost = cut.filter((n) => n?.kind === 'fail').length
      if (lost > 0) record.bridgeDropped = (Number(record.bridgeDropped) || 0) + lost
    }
  }

  /** 未确认不能当作没发送；完整异常只留日志。 */
  function noteSendFailure(record, text, err) {
    if (!enabled()) return
    const reason = err?.message ? String(err.message) : String(err ?? '未知原因')
    const status = ['not-sent', 'rejected'].includes(err?.onebotDelivery) ? err.onebotDelivery : 'uncertain'
    push(record, { kind: 'fail', text: snip(text), status, at: Date.now() })
    logger?.warn?.(`[dsh-qq] ${record?.label ?? ''} 通道回执 ${status}（${reason}）`)
  }

  /** WS 断开时记录时刻，尚未尝试发送的会话不添加提示。 */
  function markDown() {
    if (!enabled()) return
    if (!up) return
    up = false
    downSince = Date.now()
    logger?.warn?.('[dsh-qq] 通道断开；发送异常将记录并在下一轮提供状态')
  }

  /** WS 连上，只给存在发送异常的会话添加恢复提示。 */
  function markUp() {
    if (!enabled()) return
    if (up) return
    up = true
    const dur = downSince ? Date.now() - downSince : 0
    downSince = 0
    const list = manager?.list?.() ?? []
    let told = 0
    for (const record of list) {
      const fails = Array.isArray(record.bridgeNotes)
        ? record.bridgeNotes.filter((n) => n.kind === 'fail')
        : []
      if (fails.length === 0) continue
      push(record, { kind: 'up', dur, at: Date.now() })
      told += 1
    }
    logger?.info?.(
      `[dsh-qq] 通道恢复（断了 ${humanSpan(dur)}）${told > 0 ? `，${told} 个会话有发送异常记录` : ''}`,
    )
  }

  /**
   * 投递前取走提示。返回空数组表示没什么要说的。
   * 取走即清空 —— 同一件事不重复念叨。
   */
  function take(record) {
    if (!enabled()) return []
    const notes = Array.isArray(record?.bridgeNotes) ? record.bridgeNotes.splice(0) : []
    if (notes.length === 0) return []

    const fails = notes.filter((n) => n.kind === 'fail')
    const ups = notes.filter((n) => n.kind === 'up')
    // 被队列上限移除的异常记录仍计入总数。
    const dropped = Number(record?.bridgeDropped) || 0
    if (record) record.bridgeDropped = 0
    const total = fails.length + dropped
    const out = []

    if (ups.length > 0) {
      const dur = Math.max(...ups.map((n) => Number(n.dur) || 0))
      out.push(`[通道] 你和 QQ 之间的连接断过 ${dur > 0 ? humanSpan(dur) : '一小会儿'}，刚刚恢复。`)
    }
    if (total > 0) {
      out.push(`[通道] 你有 ${total} 条消息未成功确认发送：`)
      const listed = fails.slice(0, MAX_FAILS)
      const labels = { 'not-sent': '未发送', rejected: '协议拒绝', uncertain: '发送结果未确认' }
      for (const f of listed) out.push(`  ·${labels[f.status] ?? labels.uncertain}：「${f.text}」`)
      if (total > listed.length) out.push(`  ·（还有 ${total - listed.length} 句没列出来）`)
      out.push('[通道] 未确认的内容可能已发送，不自动重发；先核对记录，不据此判断对方是否收到或是否回应。')
    }
    return out
  }
  return { noteSendFailure, markDown, markUp, take, isUp: () => up, humanSpan }
}
