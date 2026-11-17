import { writeFile, unlink } from 'node:fs/promises'

/** 在解码或继续读取之前限制容量；不把 Content-Length 当作实际大小。 */
export function decodeBase64(value, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('下载大小限制无效')
  const text = String(value).replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text) || text.length % 4 === 1) throw new Error('base64 格式错误')
  const length = Math.floor(text.replace(/=+$/, '').length * 3 / 4)
  if (length > maxBytes) throw new Error('下载超过大小限制')
  const data = Buffer.from(text, 'base64')
  if (data.length > maxBytes) throw new Error('下载超过大小限制')
  return data
}

export async function writeDownload(path, data) {
  try { await writeFile(path, data) }
  catch (error) { await unlink(path).catch(() => {}); throw error }
  return path
}

export async function readDownload(url, maxBytes, { signal = AbortSignal.timeout(20000) } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('下载大小限制无效')
  const response = await fetch(url, { signal })
  let reader
  try {
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const length = response.headers.get('content-length')
    if (length && /^\d+$/.test(length) && Number(length) > maxBytes) throw new Error('下载超过大小限制')
    if (!response.body) return { data: Buffer.alloc(0), type: response.headers.get('content-type') ?? '' }
    reader = response.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error('下载超过大小限制')
      chunks.push(Buffer.from(value))
    }
    return { data: Buffer.concat(chunks, total), type: response.headers.get('content-type') ?? '' }
  } catch (error) {
    if (reader) await reader.cancel().catch(() => {})
    else await response.body?.cancel().catch(() => {})
    throw error
  } finally { reader?.releaseLock() }
}
