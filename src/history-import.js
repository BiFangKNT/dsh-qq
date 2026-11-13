import { readFile, readdir, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { resolvePeerWorkspace } from './workspace.js'

/** 旧 Markdown 只在首次查询该聊天时导入；原文件保留，新流水不再反向导入。 */
export async function importChatHistory(store, config, meta) {
  const workspace = resolvePeerWorkspace(config, meta.scope, meta.peerId)
  if (!workspace) return
  const dir = resolve(workspace, '聊天记录')
  if (store.historyImported(meta, dir)) return
  const entries = []
  const cutoff = store.historyCutoff()
  let files
  try {
    if ((await lstat(workspace)).isSymbolicLink() || (await lstat(dir)).isSymbolicLink()) throw new Error('旧流水目录不能是链接')
    files = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return
  }
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(file.name)) continue
    if (!file.isFile()) throw new Error(`旧流水不是普通文件：${file.name}`)
    const day = file.name.slice(0, 10), lines = (await readFile(join(dir, file.name), 'utf8')).split('\n')
    for (let n = 0; n < lines.length; n++) {
      if (!lines[n].startsWith('- ')) continue
      const match = /^- (\d{2}:\d{2}:\d{2}) · (.*?)：(.*)$/.exec(lines[n].replace(/\r$/, ''))
      const receivedAt = match ? new Date(`${day}T${match[1]}`).getTime() : NaN
      if (!Number.isFinite(receivedAt)) throw new Error(`旧流水格式错误：${file.name}:${n + 1}；原文件保留`)
      if (receivedAt >= cutoff) continue
      const senderId = /\((\d+)\)$/.exec(match[2])?.[1]
      const direction = senderId ? senderId === String(meta.selfId) ? 'outgoing' : 'incoming' : 'unknown'
      const messageId = / #msg=(-?\d+)$/.exec(match[3])?.[1]
      const hash = createHash('sha256').update(`${dir}/${file.name}:${n}`).digest('hex')
      entries.push({ id: direction !== 'outgoing' && messageId ? messageId : `archive:${hash}`, messageId,
        direction, body: match[3].replace(/ #msg=-?\d+$/, '').replaceAll(' ⏎ ', '\n'),
        message: { senderId, senderName: match[2] }, receivedAt, source: {}, archive: true })
    }
  }
  store.importHistory(meta, dir, entries)
}
