import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { OneBotClient } from '../src/onebot/client.js'
import { sendToolMessage } from '../src/tool-result.js'
import { setTimeout as delay } from 'node:timers/promises'

async function connection(t, { holdFirstHandshake = false } = {}) {
  const handshakes = [], firstHandshake = Promise.withResolvers()
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1',
    ...(holdFirstHandshake ? { verifyClient(info, accept) {
      const handshake = { request: info.req, accept }
      handshakes.push(handshake)
      if (handshakes.length === 1) firstHandshake.resolve(handshake)
      else accept(true)
    } } : {}),
  })
  await once(server, 'listening')
  const sockets = [], calls = []
  server.on('connection', ws => {
    sockets.push(ws)
    ws.on('message', raw => {
      const input = JSON.parse(raw)
      calls.push(input)
      if (input.action !== 'hold') ws.send(JSON.stringify({ echo: input.echo, status: 'ok', retcode: 0, data: { message_id: 0 } }))
    })
  })
  const client = new OneBotClient({ url: `ws://127.0.0.1:${server.address().port}`, reconnectMs: 1000, logger: {} })
  client.on('error', () => {})
  t.after(async () => {
    client.stop()
    for (const ws of server.clients) ws.terminate()
    for (const { request } of handshakes) request.socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  const open = async () => { const pending = once(client, 'open'); client.start(); await pending }
  return { server, client, sockets, calls, open, handshakes, firstHandshake: firstHandshake.promise }
}

test('重复 start 在连接中和已连接时均幂等；stop 后不留下自动重连', async t => {
  const h = await connection(t), opened = once(h.client, 'open')
  h.client.start().start().start()
  await opened
  h.client.start()
  assert.equal(await sendToolMessage(h.client, 'send_private_msg', {}), 0)
  assert.equal(h.sockets.length, 1)
  const pending = assert.rejects(h.client.call('hold'), error => error.onebotDelivery === 'uncertain')
  h.client.stop()
  h.client.stop()
  await pending
  await delay(1100)
  assert.equal(h.sockets.length, 1)
  assert.equal(h.client.connected, false)
})

for (const parameter of ['url', 'token']) {
  test(`握手中更新 ${parameter} 会替换旧连接，同配置重复启动仍幂等`, { timeout: 5000 }, async t => {
    const h = await connection(t, { holdFirstHandshake: true })
    const target = parameter === 'url' ? await connection(t) : h
    h.client.start()
    const first = await h.firstHandshake
    const closed = once(first.request.socket, 'close')
    const opened = once(h.client, 'open', { signal: AbortSignal.timeout(2000) })
    if (parameter === 'url') h.client.url = target.client.url
    else h.client.token = 'test-token'
    h.client.start().start()
    await opened
    first.accept(true) // 旧握手的迟到结果不能建立另一条有效连接。
    await closed
    assert.equal(await sendToolMessage(h.client, 'send_private_msg', {}), 0)
    h.client.start()
    assert.equal(h.client.connected, true)
    assert.equal(target.sockets.length, 1)
    if (parameter === 'url') {
      assert.equal(h.sockets.length, 0)
      assert.equal(h.handshakes.length, 1)
    } else {
      assert.equal(h.handshakes.length, 2)
      assert.equal(h.handshakes[1].request.headers.authorization, 'Bearer test-token')
    }
  })
}

test('旧连接所有迟到回调不影响新连接、请求及重连计划', async t => {
  const original = WebSocket.prototype.send, clientSockets = []
  t.mock.method(WebSocket.prototype, 'send', function (...args) {
    if (!this._isServer && !clientSockets.includes(this)) clientSockets.push(this)
    return original.apply(this, args)
  })
  const h = await connection(t)
  await h.open()
  await h.client.call('ping')
  const old = clientSockets[0]
  h.client.stop()
  await h.open()
  const pending = h.client.call('hold', {}, 2000)
  while (h.calls.at(-1)?.action !== 'hold') await delay(5)
  const echo = h.calls.at(-1).echo
  const events = []
  for (const name of ['open', 'close', 'event', 'error']) h.client.on(name, () => events.push(name))
  old.emit('open')
  old.emit('message', Buffer.from(JSON.stringify({ echo, status: 'ok', data: { message_id: 99 } })))
  old.emit('message', Buffer.from(JSON.stringify({ post_type: 'message', message: 'stale' })))
  old.emit('error', new Error('stale'))
  old.emit('close', 1006, 'stale')
  assert.deepEqual(events, [])
  assert.equal(h.client.connected, true)
  h.sockets.at(-1).send(JSON.stringify({ echo, status: 'ok', data: { message_id: -71 } }))
  assert.equal((await pending).message_id, -71)
  await delay(1100)
  assert.equal(h.sockets.length, 2)
})

test('自动重连等待期手动 start 只建立一条连接；连接中 stop 不再开连接', async t => {
  const h = await connection(t)
  await h.open()
  const closed = once(h.client, 'close')
  h.sockets[0].close()
  await closed
  await h.open()
  await delay(1100)
  assert.equal(h.sockets.length, 2)
  assert.equal(h.client.connected, true)
  h.client.stop()
  h.client.start()
  h.client.stop()
  await delay(50)
  assert.equal(h.client.connected, false)
})

for (const mode of ['rejected', 'timeout', 'disconnect', 'missing-id', 'signed-id']) {
  test(`OneBot真实本地WebSocket：${mode}不重试，保留明确结果`, async t => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await once(server, 'listening')
    let calls = 0
    server.on('connection', ws => ws.on('message', raw => {
      calls++
      const input = JSON.parse(raw)
      if (mode === 'timeout') return
      if (mode === 'disconnect') return ws.close()
      ws.send(JSON.stringify(mode === 'rejected' ? { echo: input.echo, status: 'failed', retcode: 1403, wording: 'not allowed' }
        : { echo: input.echo, status: 'ok', retcode: 0, data: mode === 'missing-id' ? {} : { message_id: -71 } }))
    }))
    const client = new OneBotClient({ url: `ws://127.0.0.1:${server.address().port}`, logger: { warn() {} } })
    t.after(async () => { client.stop(); for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)) })
    client.on('error', () => {})
    const opened = once(client, 'open')
    client.start()
    await opened
    const limited = { call: (action, params) => client.call(action, params, 50) }
    const pending = sendToolMessage(limited, 'send_private_msg', { user_id: 10001, message: 'test' })
    if (mode === 'signed-id') assert.equal(await pending, -71)
    else await assert.rejects(pending, mode === 'rejected' ? /协议拒绝/ : /未确认/)
    assert.equal(calls, 1)
  })
}

test('OneBot未连接：调用前即可确认未发送', async () => {
  const client = new OneBotClient({ url: 'ws://127.0.0.1:1' })
  await assert.rejects(sendToolMessage(client, 'send_private_msg', {}), /未发送/)
})
