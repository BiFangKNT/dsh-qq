import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { installSettingsApi } from '../src/settings.js'
import { settingsKey } from '../src/settings-access.js'
import { ApprovalChannel } from '../src/approval.js'
import { QuestionChannel } from '../src/questions.js'
import { waitFor } from './mock-dsh.mjs'

async function directory(t) {
  const home = await mkdtemp(join(tmpdir(), 'qq-access-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}
async function listen(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}
function rawStatus(origin, headers, path = '/api/dsh-qq/status') {
  return new Promise((resolve, reject) => {
    const request = httpRequest(origin + path, { headers }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject)
    request.end()
  })
}
async function settings(t, { local = false } = {}) {
  const home = await directory(t), cleanups = [], routes = []
  let host
  if (!local) host = await listen(t, (req, res) => routes[0].handler(req, res))
  let localPort = 0
  if (local) {
    const reserve = createServer()
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
    localPort = reserve.address().port
    await new Promise(resolve => reserve.close(resolve))
  }
  const config = { localApiPort: localPort, localApiOrigins: ['http://127.0.0.1:3080'], accessToken: 'fictional-napcat-secret' }
  const overridesRef = { current: { accessToken: config.accessToken } }
  const ctx = { get: () => () => home, effect: setup => { const dispose = setup(); if (dispose) cleanups.push(dispose) } }
  installSettingsApi({ ctx, config, logger: {}, overridesRef,
    ...(host ? { webServer: { getOrigin: () => host.origin, register: route => { routes.push(route); return () => {} } } } : {}) })
  t.after(() => cleanups.toReversed().forEach(dispose => dispose()))
  const origin = host?.origin ?? `http://127.0.0.1:${localPort}`
  const key = local ? (await readFile(join(home, 'settings-key'), 'utf8')).trim() : ''
  if (local) await waitFor(async () => { try { return (await fetch(origin + '/api/dsh-qq/status')).status === 401 } catch { return false } })
  const request = (path, options = {}) => fetch(origin + '/api/dsh-qq' + path, options)
  return { config, home, key, origin, request, headers: local ? { authorization: `Bearer ${key}` } : {} }
}

test('宿主设置拒绝跨源、DNS重绑定目标和简单表单，正常同源JSON继续可用', async t => {
  const h = await settings(t)
  for (const path of ['/status', '/settings', '/sources', '/prompt-sync', '/compatibility', '/reconnect']) {
    const response = await h.request(path, { headers: { origin: 'https://untrusted.invalid' } })
    assert.equal(response.status, 403, path)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  }
  assert.equal(await rawStatus(h.origin, { host: 'rebinding.invalid' }), 403)
  assert.equal((await h.request('/status', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await h.request('/settings', { method: 'POST', body: '{"patch":{"debug":true}}' })).status, 415)
  assert.equal(h.config.debug, undefined)
  const response = await h.request('/settings', { method: 'POST', headers: { origin: h.origin, 'content-type': 'application/json' }, body: '{"patch":{"debug":true}}' })
  assert.equal(response.status, 200)
  assert.equal(h.config.debug, true)
})

test('独立服务每个接口都需要管理密钥，来源精确匹配，预检不暴露资料', async t => {
  const h = await settings(t, { local: true })
  for (const path of ['/status', '/settings', '/sources', '/prompt-sync', '/compatibility', '/reconnect']) {
    assert.equal((await h.request(path)).status, 401, path)
    assert.equal((await h.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, path)
  }
  assert.equal((await h.request('/status', { headers: { authorization: 'Bearer wrong' } })).status, 401)
  assert.equal(await rawStatus(h.origin, { ...h.headers, host: 'rebinding.invalid' }), 403)
  for (const origin of ['null', 'https://untrusted.invalid', 'http://127.0.0.1:3081']) {
    const denied = await h.request('/settings', { headers: { ...h.headers, origin } })
    assert.equal(denied.status, 403)
    assert.equal(denied.headers.get('access-control-allow-origin'), null)
  }
  const preflight = await h.request('/settings', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:3080',
    'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } })
  assert.equal(preflight.status, 204)
  assert.equal(await preflight.text(), '')
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3080')
  const result = await h.request('/settings', { headers: { ...h.headers, origin: 'http://127.0.0.1:3080' } })
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3080')
})

test('设置不回显token；省略保留、显式替换和清空、null恢复profile分别生效', async t => {
  const h = await settings(t)
  const get = await h.request('/settings')
  const initial = await get.json()
  assert.equal(initial.meta.accessTokenSet, true)
  assert.equal(initial.values.accessToken, undefined)
  assert.equal(initial.overrides.accessToken, undefined)
  const post = async patch => {
    const response = await h.request('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch }) })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.doesNotMatch(text, /fictional-napcat-secret|replacement-secret/)
    return JSON.parse(text)
  }
  await post({ debug: true })
  assert.equal(h.config.accessToken, 'fictional-napcat-secret')
  assert.equal((await post({ accessToken: 'replacement-secret' })).accessTokenSet, true)
  assert.equal(h.config.accessToken, 'replacement-secret')
  assert.equal((await post({ accessToken: '' })).accessTokenSet, false)
  assert.equal(h.config.accessToken, '')
  assert.equal((await post({ accessToken: null })).accessTokenSet, true)
  assert.equal(h.config.accessToken, 'fictional-napcat-secret')
  for (const origins of [['*'], ['null'], ['http://127.0.0.1:3080/path'], ['https://user:password@example.invalid']]) {
    assert.equal((await h.request('/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { localApiOrigins: origins } }) })).status, 400)
  }
})

test('管理密钥持久保留且不同实例独立；坏密钥不被静默覆盖', async t => {
  const one = await directory(t), two = await directory(t)
  const key = settingsKey(one)
  assert.equal(settingsKey(one).token, key.token)
  assert.notEqual(settingsKey(two).token, key.token)
  await writeFile(key.file, 'broken-key')
  assert.throws(() => settingsKey(one), /格式无效/)
  assert.equal(await readFile(key.file, 'utf8'), 'broken-key')
})

function channel(t, Channel, { scope = 'group', send } = {}) {
  const config = { replyToPrivate: true, privateMode: 'open', groupMode: 'open', ownerIds: ['11001'] }
  const record = { sessionId: 'test', selfId: '90001', scope, peerId: scope === 'group' ? '70001' : '11001', lastSenderId: 11002, label: '测试聊天' }
  let handler
  const lines = []
  const instance = new Channel({ config, manager: { find: id => id === 'test' ? record : null }, logger: {},
    send: (record, text) => { lines.push(text); return send?.(instance, record) } })
  instance.install({ get: () => ({}), on: (_event, listener) => { handler = listener } })
  t.after(() => instance.cancelAll())
  const request = extra => handler({ agent: { session: { header: { id: 'test' }, snapshotEvents: () => [] } },
    questions: [{ id: 'q1', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }], ...extra }, () => 'host-provider')
  const actor = patch => ({ selfId: record.selfId, scope: record.scope, peerId: record.peerId, senderId: '11001', atMe: true, ...patch })
  return { instance, record, config, lines, request, actor }
}

test('群审批只接受当前聊天的授权账号显式@后的三个确切答复，撤权立即生效', async t => {
  const h = channel(t, ApprovalChannel), pending = h.request({ callId: 'call-1' })
  assert.match(h.lines[0], /仅授权账号[\s\S]*@ 机器人/)
  for (const actor of [h.actor({ senderId: '11002' }), h.actor({ atMe: false }), h.actor({ peerId: '70002' }),
    h.actor({ selfId: '90002' }), h.actor({ scope: 'private' })]) assert.equal(h.instance.tryResolve(h.record, '通过', actor), false)
  for (const text of ['好', 'yes', '允许', '通过吧', 'toString', '__proto__']) assert.equal(h.instance.tryResolve(h.record, text, h.actor()), false)
  h.config.ownerIds = []
  assert.equal(h.instance.tryResolve(h.record, '通过', h.actor()), false)
  h.config.ownerIds = ['11001']
  assert.equal(h.instance.tryResolve(h.record, '通过', h.actor()), true)
  assert.equal(await pending, 'allowed-once')
  assert.equal(h.instance.tryResolve(h.record, '通过', h.actor()), false)
  for (const [answer, result] of [['拒绝', 'rejected'], ['取消', 'cancelled']]) {
    const next = h.request({ callId: answer })
    assert.equal(h.instance.tryResolve(h.record, answer, h.actor()), true)
    assert.equal(await next, result)
  }
})

test('私聊审批仅授权对方可答，普通私聊请求留给宿主provider', async t => {
  const h = channel(t, ApprovalChannel, { scope: 'private' })
  const pending = h.request({})
  assert.equal(h.instance.tryResolve(h.record, '通过', h.actor({ senderId: '11002' })), false)
  assert.equal(h.instance.tryResolve(h.record, '通过', h.actor()), true)
  assert.equal(await pending, 'allowed-once')
  h.config.ownerIds = []
  assert.equal(await h.request({}), 'host-provider')
  assert.equal(h.lines.length, 1)
})

test('群问答绑定最末发言人，其他成员和不@的消息不能代答；私聊绑定对方', async t => {
  for (const scope of ['group', 'private']) {
    const h = channel(t, QuestionChannel, { scope }), pending = h.request({})
    const senderId = scope === 'group' ? '11002' : '11001'
    assert.equal(h.instance.tryResolve(h.record, '1', h.actor({ senderId: '11003' })), false)
    if (scope === 'group') assert.equal(h.instance.tryResolve(h.record, '1', h.actor({ senderId, atMe: false })), false)
    assert.equal(h.instance.tryResolve(h.record, '1', h.actor({ senderId, peerId: 'other-chat' })), false)
    assert.equal(h.instance.tryResolve(h.record, '2', h.actor({ senderId })), true)
    assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['乙'] }] })
  }
})

test('取消多题请求不继续发下一题，并行请求不能覆盖当前等待对象', async t => {
  const h = channel(t, QuestionChannel)
  const questions = [{ id: 'q1', question: '第一题' }, { id: 'q2', question: '第二题' }]
  const pending = h.request({ questions })
  assert.deepEqual(await h.request({ questions: [{ id: 'other', question: '不能插队' }] }), { answers: [{ id: 'other', selected: [] }] })
  assert.equal(h.lines.length, 1)
  h.instance.cancelPending(h.record.sessionId)
  assert.deepEqual(await pending, { answers: questions.map(({ id }) => ({ id, selected: [] })) })
  assert.equal(h.lines.length, 1)
  h.record.lastSenderId = null
  assert.deepEqual(await h.request({ questions }), { answers: questions.map(({ id }) => ({ id, selected: [] })) })
  assert.equal(h.lines.length, 1)
})

for (const Channel of [ApprovalChannel, QuestionChannel]) {
  test(`${Channel.name} 在发送提示前挂好等待，发送挂起时仍能取消，失败不会遗留等待`, async t => {
    const h = channel(t, Channel, { send(instance, record) {
      const answer = Channel === ApprovalChannel ? '通过' : '1'
      const senderId = Channel === ApprovalChannel ? '11001' : '11002'
      assert.equal(instance.tryResolve(record, answer, { selfId: record.selfId, scope: record.scope,
        peerId: record.peerId, senderId, atMe: true }), true)
    } })
    const result = await h.request({})
    assert.deepEqual(result, Channel === ApprovalChannel ? 'allowed-once' : { answers: [{ id: 'q1', selected: ['甲'] }] })
    const stalled = channel(t, Channel, { send: () => new Promise(() => {}) })
    const controller = new AbortController(), pending = stalled.request({ signal: controller.signal })
    controller.abort()
    assert.deepEqual(await pending, Channel === ApprovalChannel ? 'cancelled' : { answers: [{ id: 'q1', selected: [] }] })
    const failed = channel(t, Channel, { send: async () => { throw new Error('发送失败') } })
    assert.deepEqual(await failed.request({}), Channel === ApprovalChannel ? 'unavailable' : { answers: [{ id: 'q1', selected: [] }] })
    assert.equal(failed.instance.tryResolve(failed.record, '通过', failed.actor()), false)
  })
}
