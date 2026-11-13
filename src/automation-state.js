import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const nonnegative = value => Number.isSafeInteger(value) && value >= 0

/** 只保存自动行为的次数、时间与提醒记录；消息正文使用现有持久队列。 */
export function createAutomationState(home = '') {
  const records = new Map()
  const keyOf = record => JSON.stringify([String(record.selfId ?? ''), record.scope, String(record.peerId)])
  function load(record) {
    const key = keyOf(record)
    if (records.has(key)) return records.get(key)
    const dir = home ? join(home, 'automation', createHash('sha256').update(key).digest('hex')) : ''
    const file = dir ? join(dir, 'state.json') : ''
    let data = { schema: 1, identity: key }
    if (file && existsSync(file)) {
      try {
        data = JSON.parse(readFileSync(file, 'utf8'))
        if (data?.schema !== 1 || data.identity !== key) throw new Error('身份或版本错误')
        if (Object.hasOwn(data, 'wake') && (!data.wake || typeof data.wake.dayKey !== 'string' || !nonnegative(data.wake.count) ||
          !nonnegative(data.wake.misses) || !nonnegative(data.wake.lastProactiveAt))) throw new Error('主动发言记录错误')
        if (Object.hasOwn(data, 'sleep') && (!data.sleep || typeof data.sleep.sleeping !== 'boolean' || !nonnegative(data.sleep.wakeAt) ||
          typeof data.sleep.remindedOn !== 'string')) throw new Error('作息记录错误')
      } catch (err) {
        throw new Error(`自动行为记录读取失败，原文件保留，请修复 ${file}: ${err.message}`)
      }
    }
    const entry = { data, file, dir }
    records.set(key, entry)
    return entry
  }
  return {
    keyOf,
    get(section, record) { return structuredClone(load(record).data[section]) },
    set(section, record, value) {
      const entry = load(record)
      const next = { ...entry.data, [section]: structuredClone(value) }
      if (entry.file) {
        mkdirSync(entry.dir, { recursive: true })
        writeFileSync(`${entry.file}.tmp`, JSON.stringify(next, null, 2), 'utf8')
        renameSync(`${entry.file}.tmp`, entry.file)
      }
      entry.data = next
    },
  }
}
