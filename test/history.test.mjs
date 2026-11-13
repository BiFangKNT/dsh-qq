import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createMessageStore } from '../src/message-store.js'
import { registerTools } from '../src/tools.js'

const meta = { selfId: '90001', scope: 'private', peerId: '10001' }
const logger = { info() {}, warn() {}, debug() {} }
function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qq-history-'))
  const store = createMessageStore(join(root, 'data')), tools = new Map()
  const config = { isolateByPeer: false, replyToPrivate: true, privateMode: 'open', groupMode: 'open',
    ownerIds: ['10001'], ...extra }
  let record = { ...meta, sessionId: 'main' }
  const manager = { selfId: meta.selfId, messageStore: store, find: id => id === 'main' ? record : null }
  registerTools({ get: name => name === 'tools' ? { register: tool => tools.set(tool.name, tool) } : null }, {
    client: { call: () => assert.fail('不得访问网络') }, manager, config, home: join(root, 'data'), logger,
  })
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, store, config, tools, manager, get record() { return record }, set record(value) { record = value },
    query: args => tools.get('qq_history').execute(args ?? {}, { agent: { session: { id: 'main' } } }) }
}
function incoming(store, target, id, body, receivedAt = Date.now()) {
  store.put(target, { id, body, message: { senderId: '10001', senderName: '测试用户', text: body }, source: {}, receivedAt })
}
function log(root, scope, peerId, day, body) {
  const dir = join(root, `${scope === 'group' ? '群' : '私聊'}_${peerId}`, '聊天记录')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${day}.md`)
  writeFileSync(file, body)
  return file
}

test('仅注册 qq_history；不依赖 chatLog 查询收发全文，失败发送不冒充已送达，状态可选', async t => {
  const h = fixture(t, { chatLog: false, ownerIds: [] })
  for (const old of ['qq_messages', 'qq_group_history', 'qq_private_history']) assert.equal(h.tools.has(old), false)
  incoming(h.store, meta, '1', '用户原文', Date.now() - 5000)
  const send = h.store.sentStart(meta, 'send_private_msg', { message: [{ type: 'text', data: { text: '机器人回复' } }] })
  h.store.sentEnd(send, 'sent', { message_id: 71 })
  const failed = h.store.sentStart(meta, 'send_private_msg', { message: [
    { type: 'text', data: { text: '未确认的回复' } }, { type: 'image', data: { file: 'base64://PRIVATE_BYTES' } },
  ] })
  h.store.sentEnd(failed, 'uncertain')
  const result = await h.query()
  assert.equal(result.messages.length, 3)
  assert.equal(result.messages[0].confirmed, false)
  assert.equal(result.messages[1].confirmed, true)
  assert.equal(result.messages[1].id, '71')
  assert.equal(result.messages[1].direction, 'outgoing')
  assert.equal(result.messages[1].text, '机器人回复')
  assert.equal(result.messages[2].direction, 'incoming')
  assert.ok(result.messages.every(row => !('status' in row)))
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BYTES/)
  const detailed = await h.query({ include_status: true })
  assert.equal(detailed.messages[0].status, 'uncertain')
  assert.equal(detailed.messages[1].status, 'sent')
  assert.equal(detailed.messages[2].status, 'pending')
  assert.equal(h.store.pending(meta).length, 1, '发送记录不进入投递队列')
  assert.deepEqual(h.store.stats(meta).map(row => ({ ...row })), [{ status: 'pending', count: 1 }])
})

test('本人可查当前聊天；仅授权账号私聊能跨聊天，目标权限和账号隔离即时生效', async t => {
  const h = fixture(t), group = { ...meta, scope: 'group', peerId: '70001' }
  const other = { ...meta, peerId: '10002' }
  incoming(h.store, group, 'group', '获准群消息')
  incoming(h.store, other, 'other', '另一私聊')
  incoming(h.store, { ...other, selfId: '90002' }, 'other-bot', '其他机器人消息')
  assert.equal((await h.query({ chat: 'group:70001' })).messages[0].text, '获准群消息')
  assert.equal((await h.query({ chat: 'user:10002' })).messages.length, 1)
  h.config.ownerIds = []
  await assert.rejects(h.query({ chat: 'group:70001' }), /授权账号私聊/)
  h.record = { ...other, sessionId: 'main' }
  assert.equal((await h.query()).messages[0].text, '另一私聊', '本人查询不需要好感度文件')
  h.config.ownerIds = ['10002']
  h.config.groupMode = 'disabled'
  await assert.rejects(h.query({ chat: 'group:70001' }), /目标聊天未获准/)
  h.config.groupMode = 'open'
  h.config.peerBots = ['10001']
  await assert.rejects(h.query({ chat: 'user:10001' }), /目标聊天未获准/)
  h.record = { ...group, sessionId: 'main' }
  h.config.ownerIds = ['70001']
  await assert.rejects(h.query({ chat: 'user:10002' }), /授权账号私聊/)
  h.config.groupMode = 'disabled'
  await assert.rejects(h.query(), /当前获准/)
})

test('命令和未准备消息仍可读原文，不下载媒体或推进准备状态', async t => {
  const h = fixture(t)
  h.store.put(meta, { id: 'command', body: null, receivedAt: Date.now(),
    source: { message: '/status', user_id: 10001, sender: { nickname: '测试用户' } } })
  h.store.discard(meta, 'command')
  const result = await h.query({ include_status: true })
  assert.equal(result.messages[0].text, '/status')
  assert.equal(result.messages[0].status, 'control')
  assert.equal(result.messages[0].senderName, '测试用户')
  assert.equal(h.store.get(meta, 'command').body, null)
})

test('旧流水一次性导入并与新记录去重；按时间翻页，不按导入顺序，也不重放旧消息', async t => {
  const h = fixture(t)
  h.config.isolateByPeer = true; h.config.workspaceRoot = h.root
  const file = log(h.root, 'private', '10001', '2020-01-01',
    '- 09:00:00 · 测试用户(10001)：旧消息 #msg=21\n' +
    '- 09:00:01 · 机器人(90001)：旧回复 ⏎ 第二行\n' +
    '- 09:00:02 · 测试用户(10001)：重复副本 #msg=22\n')
  log(h.root, 'private', '10001', '2099-01-01', '- 09:00:00 · 测试用户(10001)：启用新库后不反向导入\n')
  incoming(h.store, meta, '22', '新库中的原文', new Date('2020-01-01T09:00:02').getTime())
  incoming(h.store, meta, '23', '最新消息')
  const first = await h.query({ limit: 2 })
  assert.deepEqual(first.messages.map(row => row.text), ['最新消息', '新库中的原文'])
  const second = await h.query({ before: first.before, include_status: true })
  assert.deepEqual(second.messages.map(row => row.text), ['旧回复\n第二行', '旧消息'])
  assert.equal(second.messages[0].direction, 'outgoing')
  assert.equal(second.messages[0].status, 'archived')
  assert.equal(h.store.pending(meta).length, 2)
  assert.ok(readFileSync(file, 'utf8').includes('旧消息'))
  writeFileSync(file, '- 10:00:00 · 测试用户(10001)：不重复导入修改后的文件\n')
  assert.equal((await h.query()).messages.length, 4)
  const restarted = createMessageStore(join(h.root, 'data'))
  assert.equal(restarted.query(meta).length, 4)
  assert.equal(restarted.historyCutoff(), h.store.historyCutoff())
  await assert.rejects(h.query({ before: 999999 }), /分页位置/)
  const other = { ...meta, peerId: '10002' }
  incoming(h.store, other, 'other', '其他聊天')
  await assert.rejects(h.query({ before: h.store.get(other, 'other').seq }), /分页位置/)
  assert.equal((await h.query({ seq: second.messages[1].seq })).messages[0].text, '旧消息')
})

test('旧流水格式错误不留下半批导入，修复后可重试；不能归属第二个机器人', async t => {
  const h = fixture(t)
  h.config.isolateByPeer = true; h.config.workspaceRoot = h.root
  const file = log(h.root, 'private', '10001', '2020-01-01', '- 09:00:00 · 测试用户(10001)：旧原文\n- broken\n')
  await assert.rejects(h.query(), /旧流水格式错误/)
  assert.equal(h.store.query(meta).length, 0)
  writeFileSync(file, '- 09:00:00 · 测试用户(10001)：旧原文\n')
  assert.equal((await h.query()).messages.length, 1)
  h.manager.selfId = '90002'; h.record = { ...meta, selfId: '90002', sessionId: 'main' }
  await assert.rejects(h.query(), /其他机器人账号/)
})

test('读取旧流水期间撤回跨聊天权限，不返回已读取的内容', async t => {
  const h = fixture(t)
  h.config.isolateByPeer = true; h.config.workspaceRoot = h.root
  log(h.root, 'group', '70001', '2020-01-01', '- 09:00:00 · 测试用户(10001)：群内原文\n')
  const query = h.query({ chat: 'group:70001' })
  h.config.ownerIds = []
  await assert.rejects(query, /授权账号私聊/)
})

test('旧发送记录幂等迁入查询，分段发送进度变化更新同一条记录，日期过滤和分页限制有效', async t => {
  const h = fixture(t), file = h.store.file
  const db = new DatabaseSync(file)
  db.prepare('DELETE FROM migrations WHERE name=?').run('history-sends-v1')
  db.prepare('INSERT INTO sends VALUES (?,?,?,?,?,?,?,?)').run('old-send', JSON.stringify(['90001', 'private', '10001']),
    'old-session', 'send_private_msg', JSON.stringify({ message: '历史回复' }), 'sent', JSON.stringify({ result: { message_id: 72 } }), 1)
  db.close()
  const restored = createMessageStore(join(h.root, 'data'))
  assert.equal(restored.query(meta)[0].body, '历史回复')
  assert.equal(restored.query(meta)[0].messageId, '72')
  createMessageStore(join(h.root, 'data'))
  assert.equal(restored.query(meta).length, 1)
  const send = h.store.sentStart(meta, 'send_private_msg', { message: '发送计划' }, 'queued')
  const seq = h.store.query(meta)[0].seq
  h.store.sentEnd(send, 'sending'); h.store.sentEnd(send, 'rejected')
  assert.equal(h.store.query(meta)[0].seq, seq)
  assert.equal(h.store.query(meta)[0].status, 'rejected')
  for (let n = 0; n < 25; n++) incoming(h.store, meta, `new-${n}`, `原文${n}`)
  assert.equal((await h.query({ limit: 1000 })).messages.length, 20)
  const filtered = await h.query({ days: 1, limit: 20 })
  assert.ok(filtered.messages.every(row => row.text !== '历史回复'))
  await assert.rejects(h.query({ offset: 1 }), /参数无效/)
  await assert.rejects(h.query({ seq: 1, before: 2 }), /参数无效/)
  await assert.rejects(h.query({ chat: '../10002' }), /chat 必须/)
})
