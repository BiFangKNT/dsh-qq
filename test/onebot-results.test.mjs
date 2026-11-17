import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { OneBotClient } from '../src/onebot/client.js'
import { sendToolMessage } from '../src/tool-result.js'

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
