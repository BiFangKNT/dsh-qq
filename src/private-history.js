import { readFile, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { listOf } from './config.js'
import { dayOf } from './chatlog.js'
import { resolvePeerWorkspace } from './workspace.js'

/** 权限检查与读取放在同一边界，工具包装层不能绕过正文权限。 */
export async function readPrivateHistory({ config, home, record, userId = '', days = 1, limit = 40, now = new Date() }) {
  if (record.scope !== 'private') throw new Error('私聊记录只在私聊中查询')
  const caller = String(record.peerId)
  const owner = listOf(config.ownerIds).includes(caller)
  if (!owner) {
    let affinity
    try {
      affinity = JSON.parse(await readFile(join(home, 'affinity.json'), 'utf8'))[caller]
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    if (affinity !== 'MAX' && !(typeof affinity === 'number' && Number.isFinite(affinity) && affinity >= 100)) {
      throw new Error('好感度达到 100 后才可查询私聊时间线')
    }
  }
  const uid = String(userId).trim()
  if (uid && !/^\d+$/.test(uid)) throw new Error('user_id 必须是 QQ 号')
  if (!owner && uid && uid !== caller) throw new Error('只有主人能查询其他人的记录')
  const ownDir = resolvePeerWorkspace(config, 'private', caller)
  if (!ownDir) throw new Error('未启用会话目录隔离，没有独立的私聊流水')
  const root = join(ownDir, '..')
  let dirs
  if (uid) dirs = [resolvePeerWorkspace(config, 'private', uid)]
  else {
    try {
      dirs = (await readdir(root, { withFileTypes: true }))
        .filter(e => e.isDirectory() && /^私聊_\d+$/.test(e.name)).map(e => join(root, e.name))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      dirs = []
    }
  }
  const span = Math.min(7, Math.max(1, Math.trunc(Number(days)) || 1))
  const count = Math.min(200, Math.max(1, Math.trunc(Number(limit)) || 40))
  const messages = []
  for (let offset = span - 1; offset >= 0; offset--) {
    const date = new Date(now)
    date.setDate(date.getDate() - offset)
    const day = dayOf(date)
    for (const dir of dirs) {
      let body
      try { body = await readFile(join(dir, '聊天记录', `${day}.md`), 'utf8') }
      catch (err) { if (err.code === 'ENOENT') continue; throw err }
      for (const line of body.split('\n')) {
        const match = /^- (\d{2}:\d{2}:\d{2}) · (.*)$/.exec(line)
        if (match) messages.push({ time: `${day} ${match[1]}`, peer: basename(dir), text: match[2] })
      }
    }
  }
  const tail = messages.sort((a, b) => a.time.localeCompare(b.time)).slice(-count)
  if (!tail.length) return '所选时间内没有私聊记录。'
  if (owner) return tail.map(m => `${m.time} · ${m.peer} · ${m.text}`).join('\n')
  return '有私聊记录的时间（不提供内容或对方身份）：\n' +
    [...new Set(tail.map(m => m.time.slice(0, 16)))].join('\n')
}
