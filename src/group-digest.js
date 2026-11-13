import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 从日记里挑一行 `> 一句话：…` 这类头信息。抽不到返回 ''。 */
export function pickDigestLine(text, label) {
  const re = new RegExp(`^>\\s*${label}\\s*[：:]\\s*(.+)$`, 'm')
  const m = re.exec(String(text ?? ''))
  return m ? m[1].trim() : ''
}

function clipLine(s, limit) {
  const t = String(s ?? '').trim()
  if (!limit || t.length <= limit) return t
  return `${t.slice(0, limit)}…`
}

/** 聊天记录一行的样子：`- 00:08:57 · 昵称(10002)：说话内容`。 */
const CHAT_LINE_RE = /^- (\d{2}:\d{2}:\d{2}) · (.+?)\((\d{3,12})\)[：:]\s*(.*)$/

/** 提取当天最近的群消息与 @ 记录；这里只转述日志，不推断用户意图。 */
function tailLinesFromChat(text, { gid = '', me = '', tailCount = 2, limit = 240 } = {}) {
  const recs = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = CHAT_LINE_RE.exec(raw.trim())
    if (!m) continue
    recs.push({ at: m[1], who: m[2].trim(), id: m[3], said: m[4].trim() })
  }
  const others = recs.filter((r) => r.id !== me)
  if (!others.length) return []

  const last = others[others.length - 1]
  const atMe = me ? others.filter((r) => r.said.includes(`@${me}`)).pop() : null
  const stripAt = (s) => String(s ?? '').split(`@${me}`).join('').trim()

  const out = []
  if (atMe === last) {
    // 最后一条已经包含 @ 信息，不重复添加
    out.push(`· 群 ${gid}：最后 ${last.at} ${last.who} 点了你名「${clipLine(stripAt(last.said), limit)}」——你没应`)
    return out
  }
  out.push(`· 群 ${gid}：最后 ${last.at} ${last.who} 说「${clipLine(last.said, limit)}」`)
  if (tailCount > 1 && others.length > 1) {
    const prev = others[others.length - 2]
    if (prev !== atMe) out.push(`  ↑前一句 ${prev.at} ${prev.who}：「${clipLine(prev.said, limit)}」`)
  }
  if (atMe) out.push(`  ⚠ ${atMe.at} ${atMe.who} 点过你名：「${clipLine(stripAt(atMe.said), 120)}」`)
  return out
}

/** 已授权私聊的群近况背景；调用方负责限制可读的群。没有聊天流水时读取已有日记摘要。 */
export function loadGroupDigest({ workspaceRoot, today, selfId = '', allowedGroups } = {}, { limit = 240, tailCount = 2 } = {}) {
  const root = String(workspaceRoot ?? '').trim()
  const day = String(today ?? '').trim()
  if (!root || !day) return ''
  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^群_/.test(d.name))
      .filter(d => !allowedGroups || allowedGroups.includes(d.name.replace(/^群_/, '')))
      .map((d) => d.name)
      .sort()
  } catch {
    return ''
  }
  const me = String(selfId ?? '').trim()
  const rows = []
  for (const name of names) {
    const gid = name.replace(/^群_/, '')
    const dir = join(root, name)
    let lines = []
    // 先读取当天聊天流水
    try {
      const chat = join(dir, '聊天记录', `${day}.md`)
      if (existsSync(chat)) lines = tailLinesFromChat(readFileSync(chat, 'utf8'), { gid, me, tailCount, limit })
    } catch {
      // 单个群读坏了（编码、锁、半截文件）不该连累别的群
    }
    // 没有可解析的流水时读取已有日记；不要求模型维护日记
    if (!lines.length) {
      try {
        const file = join(dir, '记忆区', '日记', `${day}.md`)
        if (existsSync(file)) {
          const gist = pickDigestLine(readFileSync(file, 'utf8'), '一句话')
          if (gist) lines = [`· 群 ${gid}（今天没人说话）：${clipLine(gist, limit)}`]
        }
      } catch {
        // 同上，坏一个不连累别的
      }
    }
    rows.push(...lines)
  }
  return rows.join('\n')
}
