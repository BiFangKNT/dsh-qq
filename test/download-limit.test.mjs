import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { decodeBase64, readDownload } from '../src/shared/download.js'
import { downloadImage } from '../src/inbound.js'

test('base64 在分配解码缓冲前检查容量，边界、空白和无补位均正确', t => {
  const original = Buffer.from
  let allocations = 0
  t.mock.method(Buffer, 'from', (...args) => { allocations++; return original(...args) })
  assert.throws(() => decodeBase64('YWJjZA==', 3), /大小限制/)
  assert.equal(allocations, 0)
  assert.equal(decodeBase64('YWJj', 3).toString(), 'abc')
  assert.equal(decodeBase64(' YWJjZA \n', 4).toString(), 'abcd')
  assert.throws(() => decodeBase64('x', 10), /格式/)
})

for (const header of [undefined, '1', 'invalid']) {
  test(`流式实际字节限额不依赖 Content-Length=${header}`, async t => {
    let reads = 0, cancelled = false
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(3)) },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 }), { headers: header ? { 'content-length': header } : {} }))
    await assert.rejects(readDownload('https://example.invalid/file', 5), /大小限制/)
    assert.equal(reads, 2)
    assert.equal(cancelled, true)
  })
}

test('声明超限在读正文前取消；HTTP 错误和流错误同样取消', async t => {
  let current
  t.mock.method(globalThis, 'fetch', async () => current)
  for (const mode of ['large', 'http', 'broken']) {
    let reads = 0, cancelled = false
    const body = new ReadableStream({
      pull(controller) { reads++; if (mode === 'broken') controller.error(new Error('broken')); else controller.enqueue(new Uint8Array(1)) },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })
    current = new Response(body, {
      status: mode === 'http' ? 403 : 200, headers: mode === 'large' ? { 'content-length': '1000' } : {},
    })
    await assert.rejects(readDownload('https://example.invalid/file', 5), /大小限制|403|broken/)
    assert.equal(reads, mode === 'broken' ? 1 : 0)
    if (mode !== 'broken') assert.equal(cancelled, true)
  }
})

test('超过限额或中断不留半文件，边界以内原样落盘', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-download-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const controller = new AbortController()
  let interrupted = false
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => interrupted ? new Response(new ReadableStream({
    start(stream) { signal.addEventListener('abort', () => stream.error(signal.reason), { once: true }) },
    pull() { controller.abort(new Error('cancelled')) },
  }, { highWaterMark: 0 })) : new Response(Buffer.alloc(9)))
  assert.equal(await downloadImage('https://example.invalid/file', dir, 8 / 1024 / 1024), null)
  assert.deepEqual(await readdir(dir), [])
  const path = await downloadImage('base64://YWJj', dir, 3 / 1024 / 1024)
  assert.equal((await readFile(path)).toString(), 'abc')
  interrupted = true
  await assert.rejects(readDownload('https://example.invalid/file', 5, { signal: controller.signal }), /cancelled/)
})

test('实际 HTTP 持续分块传输超限后关闭连接，不等待完整响应', { timeout: 5000 }, async t => {
  const closed = Promise.withResolvers()
  let chunks = 0
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    const timer = setInterval(() => { response.write(Buffer.alloc(32)); chunks++ }, 5)
    response.on('close', () => { clearInterval(timer); closed.resolve() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await assert.rejects(readDownload(`http://127.0.0.1:${server.address().port}`, 64), /大小限制/)
  await closed.promise
  assert.ok(chunks >= 3 && chunks < 30)
})
