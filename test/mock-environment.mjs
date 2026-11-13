import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { apply, Config } from '../src/index.js'
import { startMockNapcat } from './mock-napcat.mjs'
import { createMockDsh, waitFor } from './mock-dsh.mjs'

/** 真插件 + 真 WS 客户端 + 两个模拟边界；运行数据全部落在独立目录。 */
export async function createMockEnvironment({ port = 0, root, config: overrides = {}, verbose = false, autoReply = true, llm } = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-qq-sim-'))
  await mkdir(root, { recursive: true })
  const routes = new Set()
  const webServer = { register(route) { routes.add(route); return () => routes.delete(route) } }
  const token = randomUUID()
  const peer = startMockNapcat({ port: 0, token, quiet: true })
  const require = createRequire(import.meta.url)
  // 仅暴露预览所需的固定文件，不提供任意目录的静态访问。
  const previewAssets = new Map([
    ['/mock-assets/settings-preview.js', () => new URL('./settings-preview.js', import.meta.url)],
    ['/mock-assets/client.js', () => new URL('../client.js', import.meta.url)],
    ['/mock-assets/react.js', () => join(require.resolve('react/package.json'), '..', 'umd', 'react.development.js')],
    ['/mock-assets/react-dom.js', () => join(require.resolve('react-dom/package.json'), '..', 'umd', 'react-dom.development.js')],
  ])
  let host, closing = false
  const server = createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(value, (_key, v) => typeof v === 'string' && v.length > 8000 ? `${v.slice(0, 8000)}…` : v))
    }
    try {
      // 非本地页面不能通过浏览器跨站操作这个开发环境。
      if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: '仅允许本模拟器页面调用' })
      if (req.url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(await readFile(new URL('./simulator.html', import.meta.url))); return
      }
      if (req.url === '/settings' && req.method === 'GET') {
        const source = await readFile(new URL('./settings-preview.html', import.meta.url))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'" })
        res.end(source); return
      }
      if (previewAssets.has(req.url) && req.method === 'GET') {
        const source = await readFile(previewAssets.get(req.url)())
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(source); return
      }
      if (req.url.startsWith('/api/dsh-qq')) {
        const route = [...routes].find(route => req.url.startsWith(route.path))
        if (!route) return send(503, { error: '插件正在重载' })
        await route.handler(req, res); return
      }
      if (req.url === '/mock/state' && req.method === 'GET') return send(200, snapshot())
      if (req.method !== 'POST') return send(404, { error: '未知路由' })
      let bytes = 0, chunks = []
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('请求超过 2MB'); chunks.push(chunk) }
      const args = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      switch (req.url) {
        case '/mock/message': emitMessage(args); break
        case '/mock/plan': host.queueTurn(args.steps); break
        case '/mock/fault': peer.failNext(args.action, args.fault); break
        case '/mock/disconnect': peer.disconnectClients(); break
        case '/mock/event': await host.emitEvent(args.sessionId, args.type, args.data); break
        case '/mock/reload': await reload(); break
        default: return send(404, { error: '未知路由' })
      }
      send(200, { ok: true })
    } catch (err) { if (!res.headersSent) send(400, { error: err.message }); else res.end() }
  })
  let origin
  const config = Config({
    wsUrl: '', accessToken: token, selfId: '10001', preset: 'mock', localApiPort: 0,
    workspaceRoot: join(root, '会话'), memoryRoot: join(root, '共享记忆'), cwd: root,
    privateMode: 'open', ownerIds: ['11001'],
    mergeWindowMs: 0, groupMinGapMs: 0, groupReplyGapMs: 0, replyDelayMeanMs: 0,
    splitDelayMeanMs: 0, splitDelayMs: 0, rateLimitPerMin: 0,
    sleepMode: false, proactiveEnabled: false,
    reconnectMs: 100, ...overrides,
  })
  // 连接和落盘位置始终固定为模拟器自身，不接受真实地址覆盖。
  Object.assign(config, { localApiPort: 0, accessToken: token, selfId: '10001', cwd: root,
    workspaceRoot: join(root, '会话'), memoryRoot: join(root, '共享记忆') })
  async function load() {
    host = createMockDsh({ home: root, webServer, verbose, autoReply, llm })
    apply(host.ctx, config)
    await waitFor(() => peer.clientCount === 1, { what: '模拟器连接' })
    await waitFor(() => peer.calls.some(call => call.action === 'get_login_info'), { what: '登录查询' })
  }
  async function reload() { await host.dispose(); await waitFor(() => peer.clientCount === 0); await load() }
  function emitMessage({ scope = 'private', peerId, userId = 11001, nickname = '模拟用户', text = '你好', atSelf = false, image = false, message, messageId, steps } = {}) {
    if (scope !== 'private' && scope !== 'group') throw new Error('scope 只能是 private 或 group')
    if (steps) host.queueTurn(steps)
    const segments = message ?? [
      ...(atSelf ? [{ type: 'at', data: { qq: '10001' } }] : []),
      ...(text ? [{ type: 'text', data: { text } }] : []),
      ...(image ? [{ type: 'image', data: { url: `${peer.mediaUrl}/fixture.png` } }] : []),
    ]
    const uid = scope === 'private' ? Number(peerId ?? userId) : Number(userId)
    peer.emitEvent({ post_type: 'message', message_type: scope, user_id: uid,
      ...(scope === 'group' ? { group_id: Number(peerId ?? 88888) } : {}), message_id: messageId,
      sender: { user_id: uid, nickname }, message: segments })
  }
  function snapshot() {
    return { root, url: origin, connected: peer.clientCount === 1,
      tools: [...host.tools.keys()], calls: peer.calls.slice(-100), posts: peer.posts,
      logs: host.logs.slice(-80), sessions: [...host.agents.values()].map(agent => ({
        id: agent.id, header: agent.session.header, received: agent.received, injected: agent.injected,
        events: agent.session.events.slice(-40), results: agent.results, tools: [...agent.scopedTools.keys()],
      })) }
  }
  try {
    await peer.start()
    config.wsUrl = peer.url
    for (const key of ['localApiPort', 'wsUrl', 'accessToken', 'selfId', 'cwd', 'workspaceRoot', 'memoryRoot']) {
      Object.defineProperty(config, key, { value: config[key], writable: false, configurable: false, enumerable: true })
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
    origin = `http://127.0.0.1:${server.address().port}`
    await load()
  } catch (err) { await host?.dispose(); await peer.close(); server.close(); throw err }
  return {
    root, url: origin, napcat: peer, config,
    get host() { return host },
    emitMessage, snapshot, reload,
    async close() {
      if (closing) return; closing = true
      await host.dispose(); await peer.close()
      server.closeIdleConnections()
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    },
  }
}
