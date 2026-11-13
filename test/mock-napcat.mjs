/** 本地 OneBot 11 模拟端：真实 WS、鉴权、消息存储、媒体夹具和可控失败。 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { WebSocketServer } from 'ws'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHHsAAAAASUVORK5CYII=', 'base64')
const WAV = Buffer.alloc(44)
WAV.write('RIFF'); WAV.writeUInt32LE(36, 4); WAV.write('WAVEfmt ', 8)
WAV.writeUInt32LE(16, 16); WAV.writeUInt16LE(1, 20); WAV.writeUInt16LE(1, 22)
WAV.writeUInt32LE(16000, 24); WAV.writeUInt32LE(32000, 28)
WAV.writeUInt16LE(2, 32); WAV.writeUInt16LE(16, 34); WAV.write('data', 36)

export function startMockNapcat({ port = 3001, token = '', selfId = 10001, selfName = '模拟助手', quiet = false, quoted = {} } = {}) {
  const calls = [], messages = new Map(), posts = [], clients = new Set(), faults = new Map()
  const forwards = new Map(), records = new Map()
  let sequence = 100000, boundPort, started = false
  const log = (...args) => { if (!quiet) console.error('[mock-napcat]', ...args) }
  for (const [id, q] of Object.entries(quoted)) setQuoted(id, q)
  const http = createServer((req, res) => {
    const image = req.url === '/fixture.png'
    if (!image && req.url !== '/fixture.wav') { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': image ? 'image/png' : 'audio/wav' })
    res.end(image ? PNG : WAV)
  })
  const wss = new WebSocketServer({ server: http, path: '/' })
  wss.on('connection', (ws, req) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) { ws.close(1008, 'bad token'); return }
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
    ws.on('error', err => log(err.message))
    ws.on('message', async buf => {
      let payload
      try { payload = JSON.parse(buf.toString()) } catch { return }
      calls.push(payload)
      const { action, params = {}, echo } = payload
      const fault = faults.get(action)?.shift()
      let response
      try {
        const data = !fault || fault.afterApply ? respond(action, params) : null
        response = fault && !fault.drop && !Object.hasOwn(fault, 'data')
          ? { status: 'failed', retcode: fault.retcode ?? 1200, wording: fault.wording ?? '模拟 API 失败', data: null }
          : { status: 'ok', retcode: 0, data: fault && Object.hasOwn(fault, 'data') ? fault.data : data }
      } catch (err) { response = { status: 'failed', retcode: 1400, wording: err.message, data: null } }
      if (fault?.drop) return
      if (fault?.delayMs) await new Promise(resolve => setTimeout(resolve, fault.delayMs))
      if (ws.readyState === 1) ws.send(JSON.stringify({ ...response, echo }))
    })
  })
  function target(params, key) {
    if (!Number.isSafeInteger(Number(params[key])) || Number(params[key]) <= 0) throw new Error(`缺少有效的 ${key}`)
  }
  function respond(action, p) {
    switch (action) {
      case 'get_login_info': return { user_id: selfId, nickname: selfName }
      case 'send_msg':
      case 'send_private_msg':
      case 'send_group_msg': {
        const group = action === 'send_group_msg' || (action === 'send_msg' && p.group_id)
        target(p, group ? 'group_id' : 'user_id')
        if (!Array.isArray(p.message) && typeof p.message !== 'string') throw new Error('message 必须是消息段数组或字符串')
        const id = ++sequence
        messages.set(String(id), { ...p, message_id: id, sender: { user_id: selfId, nickname: selfName }, time: Math.floor(Date.now() / 1000) })
        return { message_id: id }
      }
      case 'get_msg': {
        const msg = messages.get(String(p.message_id))
        if (!msg) throw new Error('消息不存在')
        return msg
      }
      case 'get_forward_msg': {
        const list = forwards.get(String(p.message_id ?? p.id))
        if (!list) throw new Error('合并转发不存在')
        return { messages: list }
      }
      case 'get_record': {
        const record = records.get(String(p.file))
        if (!record) throw new Error('语音不存在，请先用 setRecord 注册夹具')
        return record
      }
      case 'delete_msg': {
        const msg = messages.get(String(p.message_id))
        if (!msg || msg.sender.user_id !== selfId) throw new Error('只能撤回自己的已有消息')
        messages.delete(String(p.message_id)); return {}
      }
      case 'send_qzone_msg': {
        if (!p.content && !p.images?.length) throw new Error('空间正文和图片不能都为空')
        if (![1, 4, 16, 64, 128].includes(p.ugc_right ?? 1)) throw new Error('无效的 ugc_right')
        const post = { ...p, tid: `mock-${++sequence}` }; posts.push(post)
        return { tid: post.tid }
      }
      case 'upload_group_file': target(p, 'group_id'); if (!p.file) throw new Error('缺少 file'); return {}
      case 'upload_private_file': target(p, 'user_id'); if (!p.file) throw new Error('缺少 file'); return {}
      case 'set_input_status': case 'send_like': case 'friend_poke': target(p, 'user_id'); return {}
      case 'group_poke': target(p, 'group_id'); target(p, 'user_id'); return {}
      case 'set_msg_emoji_like': if (!messages.has(String(p.message_id))) throw new Error('消息不存在'); return {}
      default: throw new Error(`未实现的 OneBot action: ${action}`)
    }
  }
  function setQuoted(id, q) {
    messages.set(String(id), { message_id: Number(id), sender: { user_id: q.userId, nickname: q.nickname ?? '模拟用户' },
      message: q.message ?? [{ type: 'text', data: { text: q.text ?? '' } }] })
  }
  function emitEvent(raw) {
    const event = { time: Math.floor(Date.now() / 1000), self_id: selfId, ...raw }
    if (event.post_type === 'message') {
      event.message_id ??= ++sequence
      messages.set(String(event.message_id), event)
    }
    for (const ws of clients) if (ws.readyState === 1) ws.send(JSON.stringify(event))
    return clients.size
  }
  function emitText({ userId, groupId, nickname = '模拟用户', text, messageId, atSelf = false }) {
    const message = []
    if (atSelf) message.push({ type: 'at', data: { qq: String(selfId), name: selfName } })
    message.push({ type: 'text', data: { text } })
    return emitEvent({ post_type: 'message', message_type: groupId ? 'group' : 'private', sub_type: groupId ? 'normal' : 'friend',
      user_id: userId, ...(groupId ? { group_id: groupId } : {}), message_id: messageId, raw_message: text, message,
      sender: { user_id: userId, nickname } })
  }
  return {
    calls, messages, posts, setQuoted,
    get clientCount() { return clients.size },
    get port() { return boundPort },
    get url() { return `ws://127.0.0.1:${boundPort}` },
    get mediaUrl() { return `http://127.0.0.1:${boundPort}` },
    clearQuoted(id) { messages.delete(String(id)) },
    setForward(id, list) { forwards.set(String(id), list) },
    setRecord(id, value = { base64: WAV.toString('base64') }) { records.set(String(id), value) },
    failNext(action, fault = {}) { const list = faults.get(action) ?? []; list.push(fault); faults.set(action, list) },
    disconnectClients() { for (const ws of clients) ws.terminate() },
    emitEvent,
    emitPrivateText: options => emitText(options),
    emitGroupText: options => emitText(options),
    async start() {
      await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', () => { http.off('error', reject); resolve() }) })
      started = true; boundPort = http.address().port; log(`监听 ${this.url}`); return this
    },
    async close() {
      for (const ws of clients) ws.terminate()
      clients.clear()
      await new Promise(resolve => wss.close(resolve))
      if (started) await new Promise((resolve, reject) => http.close(err => err ? reject(err) : resolve()))
      started = false
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { createInterface } = await import('node:readline')
  const args = process.argv.slice(2)
  const option = (name, value) => args.includes(name) ? args[args.indexOf(name) + 1] : value
  const server = await startMockNapcat({ port: Number(option('--port', 3001)), token: option('--token', '') }).start()
  console.error('[mock-napcat] 输入一行 JSON 广播事件；Ctrl+C 退出')
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => { try { server.emitEvent(JSON.parse(line)) } catch (err) { console.error(err.message) } })
  process.on('SIGINT', async () => { lines.close(); await server.close() })
}
