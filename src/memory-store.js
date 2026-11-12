import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, constants } from 'node:fs'
import { join, dirname, basename } from 'node:path'

const hash = value => createHash('sha256').update(value).digest('hex')
const states = new Set(['active', 'completed', 'cancelled', 'unverified', 'expired', 'removed'])
const kinds = new Set(['task', 'fact', 'term', 'candidate'])
const clean = value => String(value ?? '').trim()

export function memoryIdentity(record) {
  const meta = { selfId: clean(record.selfId), scope: record.scope, peerId: clean(record.peerId) }
  if (!meta.selfId || !['private', 'group'].includes(meta.scope) || !meta.peerId) throw new Error('记忆缺少机器人或聊天身份')
  return meta
}

/** 单一正本；每次读盘，写入成功后才返回新版本，坏文件绝不覆盖为空。 */
export function createMemoryStore(home, { now = Date.now, taskTtlMs = () => 86400000 } = {}) {
  if (!home) throw new Error('记忆存储需要插件家目录')
  const location = meta => join(home, 'memory', hash(JSON.stringify(memoryIdentity(meta))), 'memory.json')
  function read(meta) {
    const identity = memoryIdentity(meta), file = location(identity)
    if (!existsSync(file)) return { schema: 1, identity, revision: 0, entries: [], jobs: [], cursors: {}, migrated: false }
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data.schema !== 1 || JSON.stringify(data.identity) !== JSON.stringify(identity) || !Number.isSafeInteger(data.revision) ||
      !Array.isArray(data.entries) || !Array.isArray(data.jobs) || !data.cursors || typeof data.cursors !== 'object' ||
      data.jobs.some(j => !j.id || !Array.isArray(j.evidence) || j.evidence.some(e => !e.id || !e.type)) ||
      Object.values(data.cursors).some(n => !Number.isSafeInteger(n) || n < -1) ||
      data.entries.some(e => !e.id || !kinds.has(e.kind) || !states.has(e.status) || typeof e.text !== 'string' ||
        !Number.isSafeInteger(e.version) || !Array.isArray(e.history) ||
        (e.verifyAt !== null && (!Number.isFinite(e.verifyAt) || e.verifyAt <= 0)))) throw new Error('记忆文件格式错误，原文件保留')
    return data
  }
  function write(meta, data, revision) {
    const current = read(meta)
    if (current.revision !== revision) throw new Error('记忆版本已改变，请重新读取')
    const file = location(meta)
    mkdirSync(dirname(file), { recursive: true })
    const next = { ...data, revision: revision + 1 }
    writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
    return next
  }
  function change(data, operation, { source = 'tool', evidence = [], confirmed = false } = {}) {
    if (!operation || !kinds.has(operation.kind ?? data.entries.find(e => e.id === operation.id)?.kind)) throw new Error('未知记忆类型')
    const existing = operation.id ? data.entries.find(e => e.id === operation.id) : null
    if (operation.id && !existing) throw new Error('记忆条目不存在')
    if (existing && operation.version !== existing.version) throw new Error('条目版本已改变，请重新读取')
    const kind = existing?.kind ?? operation.kind
    const status = operation.status ?? existing?.status ?? (kind === 'candidate' ? 'unverified' : 'active')
    const text = clean(operation.text ?? existing?.text)
    if (!text || !states.has(status)) throw new Error('记忆内容或状态无效')
    if (!existing && data.entries.some(e => e.kind === kind && e.text === text)) {
      if (source === 'legacy') return data.entries.find(e => e.kind === kind && e.text === text)
      throw new Error('相同记忆已存在，请按 id 与 version 更新')
    }
    if (kind === 'candidate' && status === 'active') throw new Error('待确认项必须通过明确记录事实或词义来确认')
    const time = now()
    let verifyAt = existing?.verifyAt ?? null
    if (Object.hasOwn(operation, 'verifyAt')) {
      if (operation.verifyAt !== null && (!Number.isFinite(operation.verifyAt) || operation.verifyAt <= 0)) throw new Error('核实时间必须是有效时间戳')
      verifyAt = operation.verifyAt
    } else if (kind === 'task' && status === 'active' && (!existing || text !== existing.text || existing.status !== status || confirmed || (source === 'tool' && operation.status === 'active'))) {
      verifyAt = Math.max(existing?.verifyAt ?? 0, time + Number(taskTtlMs()))
    }
    if (kind === 'task' && status === 'active' && verifyAt == null) throw new Error('进行中事项必须有核实时间，不能设为永久有效')
    if (verifyAt !== null && (!Number.isFinite(verifyAt) || verifyAt <= 0)) throw new Error('核实时间无效，请检查事项核实间隔配置')
    const entry = { id: existing?.id ?? randomUUID(), kind, text, status,
      version: (existing?.version ?? 0) + 1, createdAt: existing?.createdAt ?? time, updatedAt: time,
      verifyAt, source, evidence, history: existing ? [...existing.history, { ...existing, history: undefined }] : [] }
    if (existing) data.entries[data.entries.indexOf(existing)] = entry
    else data.entries.push(entry)
    return entry
  }
  function effective(entry) {
    return entry.status === 'active' && entry.verifyAt != null && now() >= entry.verifyAt
      ? { ...entry, status: entry.kind === 'task' ? 'unverified' : 'expired' } : entry
  }
  function migrate(meta) {
    const data = read(meta)
    if (data.migrated) return data
    const dir = clean(meta.dir)
    if (!dir) return write(meta, { ...data, migrated: true }, data.revision)
    const ownFile = join(dir, '.memory-migration-owner.json')
    mkdirSync(dir, { recursive: true })
    const owner = JSON.stringify(memoryIdentity(meta))
    try { writeFileSync(ownFile, owner, { flag: 'wx', mode: 0o600 }) } catch (err) { if (err.code !== 'EEXIST') throw err }
    if (readFileSync(ownFile, 'utf8') !== owner) return write(meta, { ...data, migrated: true, migrationNotice: '旧目录归属不同，未自动导入' }, data.revision)
    const sources = [join(dir, '话头.md'), join(dir, '便签.md'), join(dir, '交接.md'),
      join(dirname(dir), '事实卡.md'), join(dir, '记忆区', '群词典.md')]
    const backup = join(dirname(location(meta)), 'legacy')
    for (const file of sources) {
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      mkdirSync(backup, { recursive: true })
      const target = join(backup, `${hash(file).slice(0, 12)}-${basename(file)}`)
      if (!existsSync(target)) copyFileSync(file, target, constants.COPYFILE_EXCL)
      if (basename(file) === '事实卡.md') {
        let section = ''
        for (const line of text.split(/\r?\n/)) {
          if (/^##\s/.test(line)) { section = line.replace(/^##\s*/, '').trim(); continue }
          if (!line.trim() || line.startsWith('#') || line.startsWith('>')) continue
          const matched = [basename(dir), `会话 ${basename(dir)}`, meta.label, `会话 ${meta.label}`].includes(section)
          if (matched || section === '全局') change(data, { kind: 'fact', text: line.trim(), status: matched ? 'active' : 'unverified' }, { source: 'legacy' })
        }
      } else if (basename(file) === '群词典.md') {
        let confirmed = false
        for (const line of text.split(/\r?\n/)) {
          if (/^##\s/.test(line)) { confirmed = /已确认/.test(line); continue }
          const cells = line.split('|').slice(1, -1).map(s => s.trim())
          if (confirmed && cells.length >= 2 && cells[0] && !/^(?:[- :]+|词\s*\/)/.test(cells[0])) {
            change(data, { kind: 'term', text: `${cells[0]}：${cells[1]}` }, { source: 'legacy' })
          } else if (/^-\s*\[\s*\]/.test(line)) change(data, { kind: 'candidate', text: line.replace(/^-\s*\[\s*\]\s*/, '') }, { source: 'legacy' })
        }
      } else {
        const lines = basename(file) === '话头.md' ? text.split(/\r?\n/).filter(l => /^-\s*\[/.test(l)) : [text.trim()]
        for (const line of lines.filter(Boolean)) change(data, { kind: 'task', text: line.replace(/^-\s*\[[ xX]*\]\s*/, ''),
          status: /^-\s*\[x\]/i.test(line) ? 'completed' : 'unverified' }, { source: 'legacy' })
      }
    }
    data.migrated = true
    return write(meta, data, data.revision)
  }
  return { read, write, change, effective, migrate, fileFor: location }
}
