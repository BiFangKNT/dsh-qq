import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

/** 按聊天保存重置代数与实际会话 ID，避免重启后恢复已重置的旧会话。 */
export function createSessionState(file, logger) {
  let data = { gens: {}, sessions: {} }
  try {
    if (file && existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const object = v => v && typeof v === 'object' && !Array.isArray(v)
      if (!object(raw) || !object(raw.gens) || !object(raw.sessions) ||
        Object.values(raw.gens).some(v => !Number.isSafeInteger(v) || v < 0) ||
        Object.values(raw.sessions).some(v => typeof v !== 'string' || !v)) throw new Error('会话映射格式错误')
      data = raw
    }
  } catch (err) {
    const message = `会话映射读取失败，原文件保留，请修复 ${file}: ${err.message}`
    logger?.error?.(message)
    throw new Error(message, { cause: err })
  }

  const save = next => {
    if (file) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), 'utf8')
      renameSync(`${file}.tmp`, file)
    }
    data = next
  }

  return {
    /** 这一路 reset 到第几代；0 表示没 reset 过。 */
    gen(baseKey) {
      const n = Number(data.gens[baseKey])
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    },
    /** 保存代数；重置时可在同次写入中移除上一代会话映射。 */
    setGen(baseKey, gen, { forgetSession = '' } = {}) {
      if (!baseKey) return
      const n = Number(gen)
      const gens = { ...data.gens }
      if (!Number.isFinite(n) || n <= 0) delete gens[baseKey]
      else gens[baseKey] = Math.floor(n)
      const sessions = { ...data.sessions }
      if (forgetSession) delete sessions[forgetSession]
      save({ ...data, gens, sessions })
    },
    /** 这一代真正用的 sessionId（没有就返回空串，调用方退回 hash）。 */
    sessionId(key) {
      const v = data.sessions[key]
      return v ? String(v) : ''
    },
    setSessionId(key, sessionId) {
      if (!key || !sessionId) return
      if (data.sessions[key] === String(sessionId)) return
      save({ ...data, sessions: { ...data.sessions, [key]: String(sessionId) } })
    },
    /** 键换代时把上一代的 id 划掉，别让账本一直涨。 */
    forgetSession(key) {
      if (!key || !(key in data.sessions)) return
      const sessions = { ...data.sessions }
      delete sessions[key]
      save({ ...data, sessions })
    },
    all() {
      return { gens: { ...data.gens }, sessions: { ...data.sessions } }
    },
  }
}
