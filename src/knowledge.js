import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, extname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { GIJINKA } from './gijinka.js'
import { document, boundary, excerpt, fitExcerpt } from './knowledge-document.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const text = value => String(value ?? '').trim()
const normalize = value => String(value).normalize('NFKC').toLowerCase()
const MAX_FILE = 512 * 1024
const MAX_SOURCE = 8 * 1024 * 1024
const MAX_FILES = 128
const MAX_CHUNKS = 10000
const MAX_RESPONSE = 16000
const inside = (root, file) => {
  const back = relative(root, file)
  return back !== '..' && !back.startsWith('..' + sep) && !isAbsolute(back)
}

function chat(value) {
  if (!value || !['private', 'group'].includes(value.scope) || !/^\d+$/.test(text(value.peerId))) throw new Error('请选择私聊或群聊，并填写 QQ 号或群号')
  return { scope: value.scope, peerId: text(value.peerId) }
}
const chatKey = value => `${value.scope}:${value.peerId}`
function validate(input) {
  if (!/^\d+$/.test(text(input.selfId))) throw new Error('请填写机器人 QQ 号')
  if (!['chat', 'public'].includes(input.scope)) throw new Error('资料范围必须是 chat 或 public')
  if (!['file', 'directory', 'pack', 'legacy-meme'].includes(input.kind)) throw new Error('请选择文件、目录、资料包或旧词库导入')
  const source = { id: input.id || randomUUID(), selfId: text(input.selfId), scope: input.scope,
    kind: input.kind, label: text(input.label).slice(0, 80) }
  if (source.scope === 'chat') source.chat = chat(input.chat)
  else {
    if (!Array.isArray(input.chats) || input.chats.length > 200) throw new Error('公共资料须明确列出可访问的聊天，最多 200 个')
    source.chats = [...new Map(input.chats.map(value => { const item = chat(value); return [chatKey(item), item] })).values()]
  }
  if (source.kind === 'pack') {
    if (input.pack !== 'ai-girls') throw new Error('未知资料包')
    source.pack = input.pack
    source.label ||= 'AI 拟人同人角色参考'
  } else {
    if (!text(input.path) || !isAbsolute(text(input.path))) throw new Error('请填写运行端的绝对路径，不支持网址')
    source.path = resolve(text(input.path))
    source.label ||= basename(source.path).slice(0, 80)
  }
  return source
}
const visible = (source, record) => source.selfId === String(record.selfId) &&
  (source.scope === 'chat' ? chatKey(source.chat) === chatKey(record) : source.chats.some(value => chatKey(value) === chatKey(record)))

async function unlinked(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('资料路径不能包含符号链接或目录联接')
    if (dirname(current) === current) break
  }
}

async function scan(source) {
  if (source.kind === 'pack') return { fingerprint: hash(JSON.stringify(GIJINKA)), bytes: JSON.stringify(GIJINKA).length, build: async () =>
    GIJINKA.map(item => document(
      `${item.name}\n对应：${item.ai}\n别名：${item.aliases.join('、')}\n外貌：${item.traits.join('、')}${item.note ? '\n' + item.note : ''}\nAI 拟人同人角色，非真人、非官方形象。来源：genderswapai.com；主要创作者 ZipZipPipe；DeepSeek 原角色上善无形，CC BY-NC-SA 4.0。`,
      item.slug, item.slug, item.name, [...item.aliases, item.ai].join(' '))) }
  await unlinked(source.path)
  const rootStat = await lstat(source.path)
  const root = await realpath(source.path)
  const entries = []
  let visited = 0, bytes = 0
  async function add(file, stat) {
    if (!stat.isFile() || stat.nlink !== 1 || !inside(rootStat.isDirectory() ? root : dirname(root), await realpath(file))) throw new Error('资料必须是范围内的独立普通文件')
    if (stat.size > MAX_FILE && source.kind !== 'legacy-meme') throw new Error('单个文本文件不能超过 512 KiB')
    bytes += stat.size
    if (bytes > (source.kind === 'legacy-meme' ? 256 * 1024 * 1024 : MAX_SOURCE)) throw new Error('资料来源超过容量限制')
    if (entries.length >= MAX_FILES) throw new Error('一个资料来源最多包含 128 个文本文件')
    entries.push({ file, name: rootStat.isDirectory() ? relative(root, file).replaceAll('\\', '/') : basename(file),
      stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` })
  }
  async function walk(dir, depth = 0) {
    if (depth > 12) throw new Error('资料目录层级不能超过 12 层')
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 2048) throw new Error('目录项目过多，请选择更具体的资料目录')
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const file = join(dir, entry.name), stat = await lstat(file)
      if (stat.isSymbolicLink()) throw new Error('资料目录包含链接，请移除链接或单独选择普通文件')
      if (stat.isDirectory()) await walk(file, depth + 1)
      else if (/\.(md|txt)$/i.test(entry.name)) await add(file, stat)
    }
  }
  if (source.kind === 'directory') {
    if (!rootStat.isDirectory()) throw new Error('所选路径不是目录')
    await walk(root)
  } else {
    if (source.kind === 'file' && !/\.(md|txt)$/i.test(extname(root))) throw new Error('首版文件仅支持 UTF-8 的 .md / .txt')
    await add(root, rootStat)
  }
  const fingerprint = hash(JSON.stringify(entries))
  return { fingerprint, bytes, build: async () => {
    let result = []
    if (source.kind === 'legacy-meme') {
      const db = new DatabaseSync(root, { readOnly: true })
      try {
        const rows = db.prepare('SELECT title,slug,tags,usage,origin,other FROM memes LIMIT 10001').all()
        if (rows.length > 10000) throw new Error('旧词库最多导入 10000 条，请拆分来源')
        let size = 0
        for (const [i, row] of rows.entries()) {
          const body = `${row.title || ''}\n${row.usage || ''}\n出处：${row.origin || ''}\n${row.other || ''}\n来源：cnmeme.wiki/词条/${row.slug || ''}`
          size += Buffer.byteLength(body) + Buffer.byteLength(text(row.tags))
          if (size > MAX_SOURCE) throw new Error('旧词库文本超过 8 MiB，请拆分来源')
          result.push(document(body, `legacy:${i}:${row.slug || ''}`, text(row.slug || row.title), text(row.title), text(row.tags), false))
        }
      } finally { db.close() }
    } else {
      for (const entry of entries) {
        const buffer = await readFile(entry.file)
        if (buffer.length > MAX_FILE) throw new Error('单个文本文件不能超过 512 KiB')
        const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
        if (body.includes('\0')) throw new Error('资料包含二进制内容')
        const aliases = body.split('\n').slice(0, 20).filter(line => /^(别名|关键词|aliases|keywords)\s*[:：]/i.test(line)).join(' ').slice(0, 1000)
        result.push(document(body, entry.name, entry.name, '', aliases, /\.md$/i.test(entry.name)))
      }
    }
    if (result.reduce((n, doc) => n + doc.blocks.length, 0) > MAX_CHUNKS) throw new Error('资料段落过多，请拆分来源')
    // 读取过程中变化时拒绝提交；不把新内容配上旧指纹。
    for (const entry of entries) {
      await unlinked(entry.file)
      const stat = await lstat(entry.file)
      if (`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` !== entry.stamp) throw new Error('读取期间资料发生变化，请重新查询')
    }
    return result
  } }
}

function terms(value) {
  const result = new Set()
  // 先分开汉字，避免后面的字母匹配把 WebSocket连接 当成同一个词。
  for (const part of normalize(value).split(/(\p{Script=Han}+)/u)) {
    if (/^\p{Script=Han}/u.test(part)) {
      const chars = [...part]
      for (let i = 0; i < chars.length; i++) {
        result.add(chars[i])
        if (i + 1 < chars.length) result.add(chars[i] + chars[i + 1])
      }
    } else for (const word of part.match(/[\p{L}\p{N}_-]+/gu) || []) result.add(word)
  }
  return [...result]
}
function indexRows(documents) {
  const rows = documents.flatMap(doc => doc.blocks.map(block => ({ doc, ...block })))
  const postings = new Map()
  rows.forEach((row, i) => {
    for (const [value, weight] of [[row.doc.body.slice(row.offset, row.endOffset), 1], [row.title + ' ' + row.doc.name, 5], [row.doc.aliases, 8]]) {
      for (const term of terms(value)) {
        if (!postings.has(term)) postings.set(term, new Map())
        const list = postings.get(term)
        list.set(i, (list.get(i) || 0) + weight)
      }
    }
  })
  return { rows, postings }
}

/** 持久保存来源，按需在内存建立索引；不复制原文件，不扫描未选入的 Workspace。 */
export function createKnowledge({ home, logger }) {
  if (!home) throw new Error('资料检索需要插件家目录')
  const dir = join(home, 'knowledge'), file = join(dir, 'knowledge.sqlite')
  const cache = new Map()
  function use(fn) {
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(file)
    try {
      db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, spec TEXT NOT NULL)')
      return fn(db)
    } finally { db.close() }
  }
  const list = selfId => use(db => db.prepare('SELECT spec FROM sources ORDER BY rowid').all().map(row => JSON.parse(row.spec)).filter(source => !selfId || source.selfId === String(selfId)))
  const selected = record => list(record.selfId).filter(source => visible(source, record))
  let availabilityError = ''
  function hasSources(record) {
    try { const result = selected(record).length > 0; availabilityError = ''; return result }
    catch (error) {
      if (availabilityError !== error.message) logger?.warn?.(`资料来源读取失败，暂不提供检索工具：${error.message}`)
      availabilityError = error.message
      return false
    }
  }
  async function save(input, assert = () => {}) {
    const source = validate(input)
    await scan(source).then(value => value.build()) // 导入前明确验证格式、容量和读取权限。
    assert()
    use(db => {
      const old = db.prepare('SELECT spec FROM sources WHERE id=?').get(source.id)
      if (input.id && (!old || JSON.parse(old.spec).selfId !== source.selfId)) throw new Error('资料来源不存在或不属于当前机器人')
      if (!old && db.prepare('SELECT count(*) AS n FROM sources').get().n >= 64) throw new Error('最多配置 64 个资料来源')
      db.prepare('INSERT INTO sources(id,spec) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET spec=excluded.spec').run(source.id, JSON.stringify(source))
    })
    cache.delete(source.id)
    return source
  }
  function remove(id, selfId) {
    use(db => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const row = db.prepare('SELECT spec FROM sources WHERE id=?').get(text(id))
        if (!row || JSON.parse(row.spec).selfId !== String(selfId)) throw new Error('资料来源不存在或不属于当前机器人')
        db.prepare('DELETE FROM sources WHERE id=?').run(id)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    })
    cache.delete(id)
  }
  async function search(record, query, limit = 5) {
    query = text(query)
    if (!query || query.length > 200) throw new Error('查询词须为 1–200 字')
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('最多返回 5 个片段')
    const allKeys = terms(query)
    const keys = (allKeys.some(key => key.length > 1) ? allKeys.filter(key => key.length > 1) : allKeys).slice(0, 64)
    const hits = [], warnings = []
    let bytes = 0, count = 0
    const initial = new Map(selected(record).map(source => [source.id, source]))
    for (const source of initial.values()) {
      try {
        const snapshot = await scan(source)
        bytes += Math.min(snapshot.bytes, MAX_SOURCE)
        if (bytes > 32 * 1024 * 1024) throw new Error('本次检索资料超过 32 MiB，请减少来源')
        // 每次查询重新读取所选原文，权限变化、同长度覆盖和删除均不能沿用旧片段。
        const fresh = await snapshot.build()
        // 标签等元数据也参与索引；WAL 更新可能完全不改变主数据库文件属性和正文。
        const fingerprint = hash(JSON.stringify(source) + snapshot.fingerprint + JSON.stringify(fresh.map(doc => [doc.id, doc.version, doc.name, doc.title, doc.aliases])))
        let index = cache.get(source.id)
        if (index?.fingerprint !== fingerprint) {
          index = { fingerprint, ...indexRows(fresh) }
          if (cache.size >= 2) cache.delete(cache.keys().next().value)
          cache.set(source.id, index)
        }
        count += index.rows.length
        if (count > 20000) throw new Error('本次检索超过 20000 个片段，请减少来源')
        const scores = new Map()
        for (const key of keys) for (const [i, weight] of index.postings.get(key) || []) scores.set(i, (scores.get(i) || 0) + weight)
        for (const [i, score] of scores) {
          const row = index.rows[i]
          hits.push({ sourceId: source.id, source, ...row,
            score: score + (normalize(row.title + row.doc.aliases + row.doc.body.slice(row.offset, row.endOffset)).includes(normalize(query)) ? 30 : 0) })
        }
      } catch (error) {
        cache.delete(source.id)
        // 失败不使用旧索引；不向普通聊天暴露运行端绝对路径。
        warnings.push({ sourceId: source.id, source: source.label, message: '来源读取或索引失败' })
        logger?.warn?.(`资料 ${source.id} 检索失败：${error.message}`)
      }
    }
    // 导入、移除或授权在异步读取期间变化时，不返回撤销了的内容。
    const current = new Map(selected(record).map(source => [source.id, JSON.stringify(source)]))
    const stillVisible = hit => current.has(hit.sourceId) && current.get(hit.sourceId) === JSON.stringify(initial.get(hit.sourceId))
    const results = hits.filter(stillVisible)
      .sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name) || a.offset - b.offset).slice(0, limit)
    const response = { results: [], warnings: [], truncated: false }
    for (const hit of results) {
      const { doc } = hit
      const body = doc.body.slice(hit.offset, hit.endOffset).toLowerCase()
      let match = body.indexOf(query.toLowerCase())
      if (match < 0) {
        for (const key of [...keys].sort((a, b) => b.length - a.length)) {
          match = body.indexOf(key)
          if (match >= 0) break
        }
      }
      const offset = boundary(doc.body, hit.offset + Math.max(0, match - 240))
      const endOffset = boundary(doc.body, Math.min(hit.endOffset, offset + 1200))
      const item = { ...excerpt(hit.source, doc, offset, endOffset, hit.endOffset), title: hit.title,
        block: { type: hit.type, offset: hit.offset, endOffset: hit.endOffset }, section: hit.section,
        partial: offset > hit.offset || endOffset < hit.endOffset }
      const fitted = fitExcerpt(item, doc, value => JSON.stringify({ ...response, results: [...response.results, value] }).length <= MAX_RESPONSE)
      if (!fitted) { response.truncated = true; continue }
      response.results.push(fitted)
      if (fitted.partial) response.truncated = true
    }
    for (const warning of warnings.filter(stillVisible)) {
      response.warnings.push(warning)
      if (JSON.stringify(response).length > MAX_RESPONSE) {
        response.warnings.pop()
        response.truncated = true
        break
      }
    }
    return response
  }
  async function read(record, { sourceId, documentId, version, offset = 0, endOffset }) {
    const source = selected(record).find(source => source.id === sourceId)
    if (!source) throw new Error('资料来源不存在或当前聊天无权读取')
    let documents
    try { documents = await scan(source).then(snapshot => snapshot.build()) }
    catch (error) {
      logger?.warn?.(`资料 ${source.id} 读取失败：${error.message}`)
      throw new Error('资料来源读取失败，请管理员在资料设置中检查')
    }
    const current = selected(record).find(item => item.id === sourceId)
    if (!current || JSON.stringify(current) !== JSON.stringify(source)) throw new Error('资料来源或授权已变更，请重新搜索')
    const doc = documents.find(doc => doc.id === documentId)
    if (!doc || !version || doc.version !== version) throw new Error('STALE_REFERENCE')
    endOffset ??= doc.body.length
    if (!Number.isInteger(offset) || !Number.isInteger(endOffset) || offset < 0 || offset > endOffset || endOffset > doc.body.length ||
      boundary(doc.body, offset) !== offset || boundary(doc.body, endOffset) !== endOffset) throw new Error('读取范围无效；请使用搜索或上次读取返回的位置')
    const item = excerpt(source, doc, offset, endOffset)
    const result = fitExcerpt(item, doc, value => JSON.stringify(value).length <= MAX_RESPONSE)
    if (!result) throw new Error('资料标识过长，无法在单次结果内返回原文')
    return result
  }
  return { list, save, remove, search, read, hasSources }
}
