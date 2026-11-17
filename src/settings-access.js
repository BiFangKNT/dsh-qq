import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function settingsKey(home) {
  const file = join(home, 'settings-key')
  try { writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  const token = readFileSync(file, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('settings-key 格式无效，请检查本地管理密钥文件')
  return { file, token }
}

export function parseSettingsOrigin(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value) {
    throw new Error('来源须为完整的 HTTP(S) origin，例如 http://127.0.0.1:3080，不含路径')
  }
  return url
}

/** 在读取正文或调用设置逻辑之前检查。Host 不从客户端 Origin 或转发头推导。 */
export function checkSettingsRequest(req, { origin, allowedOrigins = [], token }) {
  const target = new URL(origin)
  if (req.headers.host !== target.host || !req.url?.startsWith('/') || req.url.startsWith('//')) {
    return { status: 403, error: '请求目标与设置服务不符' }
  }
  const source = req.headers.origin
  if (source && ![origin, ...allowedOrigins].includes(source) || source === 'null') {
    return { status: 403, error: '此页面来源未获准访问设置服务' }
  }
  if (!token && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
    return { status: 403, error: '宿主设置接口仅允许同源访问' }
  }
  if (req.method === 'OPTIONS') {
    if (!token || !source || !['GET', 'POST'].includes(req.headers['access-control-request-method']) ||
      (req.headers['access-control-request-headers'] ?? '').split(',').some(header =>
        header.trim() && !['authorization', 'content-type'].includes(header.trim().toLowerCase()))) {
      return { status: 403, error: '不支持此跨源请求' }
    }
    return { status: 204 }
  }
  if (token) {
    const supplied = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return { status: 401, error: '需要有效的本地管理密钥' }
  }
  if (!['GET', 'POST'].includes(req.method)) return { status: 405, error: '不支持此操作' }
  if (req.method === 'POST' && req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return { status: 415, error: '设置请求须使用 application/json' }
  }
  return null
}
