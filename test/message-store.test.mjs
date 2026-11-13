import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createMessageStore } from '../src/message-store.js'
import { registerMessageTool } from '../src/message-tools.js'

const meta = { selfId: '90001', scope: 'group', peerId: '70001' }
const item = id => ({ id: String(id), source: { post_type: 'message', message_type: 'group', self_id: 90001,
  group_id: 70001, message_id: id, user_id: 10001, message: `原文${id}` },
  body: `原文${id}`, message: { text: `原文${id}`, triggerText: `原文${id}` },
  receivedAt: 12345 + id, decision: 'yes', attachmentPaths: [`/cache/${id}.png`] })
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-message-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
test('持久保存原文、跨账号隔离，进入会话、模型完成、遗漏和发送结果分别记账', t => {
  const home = directory(t), store = createMessageStore(home)
  for (let n = 1; n <= 3; n++) store.put(meta, item(n))
  store.put({ ...meta, selfId: '90002' }, item(1))
  store.put(meta, item(1))
  assert.equal(store.pending(meta).length, 3)
  const rows = store.pending(meta), id = store.begin(meta, 'main-1', rows.slice(1), [rows[0].seq])
  store.finish(id, 'admitted')
  assert.equal(store.get(meta, '2').status, 'admitted')
  assert.equal(store.get(meta, '1').status, 'omitted')
  store.finish(id, 'processed')
  const restarted = createMessageStore(home)
  assert.equal(restarted.pending(meta).length, 0)
  assert.equal(restarted.get(meta, '1').body, '原文1')
  assert.equal(restarted.get(meta, '2').status, 'processed')
  assert.equal(restarted.pending({ ...meta, selfId: '90002' }).length, 1)
  assert.ok(restarted.protectedPaths().has('/cache/1.png'), '未提供的附件仍受保护')
  assert.ok(!restarted.protectedPaths().has('/cache/2.png'), '已完成附件回到普通缓存期限')
  const send = restarted.sentStart({ ...meta, sessionId: 'main-1', activeDeliveryId: id }, 'send_group_msg', { text: '第二段' }, 'queued')
  restarted.sentEnd(send, 'sending')
  restarted.sentEnd(send, 'uncertain', { message: '回执丢失' })
  assert.equal(restarted.sends(meta)[0].status, 'uncertain')
  assert.equal(JSON.parse(restarted.sends(meta)[0].result).deliveryId, id)
  assert.equal(restarted.get(meta, '2').status, 'processed', '外发失败不重做模型')
})

test('崩溃恢复根据宿主证据去重，未知接纳结果和工具执行后的失败不自动重放', () => {
  const store = createMessageStore()
  try {
    store.put(meta, item(1))
    const first = store.begin(meta, 'main', store.pending(meta))
    let events = []
    const record = { ...meta, sessionId: 'main', agent: { session: { snapshotEvents: () => events } } }
    store.recover(record)
    assert.equal(store.get(meta, '1').status, 'pending', '未接纳可重新交付')
    const second = store.begin(meta, 'main', store.pending(meta))
    events = [{ seq: 0, type: 'agent/inbox/spliced', data: { inserted: [{ source: { qqDeliveryId: second } }] } }]
    store.recover(record)
    assert.equal(store.get(meta, '1').status, 'failed', '仅有持久 inbox 也不能盲目重新追加')
    store.put(meta, item(2))
    const third = store.begin(meta, 'main', store.pending(meta))
    events = [
      { seq: 1, type: 'turn/start', data: { turn: 2 } },
      { seq: 2, type: 'user/message', data: { source: { qqDeliveryId: third } } },
      { seq: 3, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    store.recover(record)
    store.recover(record)
    assert.equal(store.get(meta, '2').status, 'processed', '沉默也推进完成位置')
    assert.equal(store.delivery(first).status, 'pending')
    store.put(meta, item(3))
    store.begin(meta, 'old-main', store.pending(meta))
    store.recover({ ...record, sessionId: 'new-main' })
    assert.equal(store.get(meta, '3').status, 'failed', '旧会话无法核实时保留，不冒险重放')
  } finally { store.close() }
})

test('旧 v1 按账号迁入一次，保留判断、未准备源事件与去重墓碑；坏文件只阻断对应聊天', t => {
  const home = directory(t), dir = join(home, 'address-classifier')
  mkdirSync(dir)
  const filename = value => createHash('sha256').update(JSON.stringify([value.selfId, value.scope, value.peerId])).digest('hex') + '.json'
  const saved = { version: 1, meta, sessionId: 'classifier-old', pending: [item(1),
    { ...item(2), body: null, message: null, decision: null }], seen: ['1', '2', 'old-done'] }
  writeFileSync(join(dir, filename(meta)), JSON.stringify(saved))
  const brokenMeta = { ...meta, peerId: '70002' }, brokenFile = join(dir, filename(brokenMeta))
  writeFileSync(brokenFile, '{broken')
  let store = createMessageStore(home, { warn() {} })
  assert.equal(store.chat(meta).session, 'classifier-old')
  assert.equal(store.unprepared(meta)[0].id, '2')
  assert.equal(store.get(meta, 'old-done').status, 'legacy-accepted')
  assert.throws(() => store.assertReadable(brokenMeta), /修复后重启/)
  assert.doesNotThrow(() => store.assertReadable(meta))
  store.finish(store.begin(meta, 'main', [store.pending(meta)[0]]), 'processed')
  store = createMessageStore(home, { warn() {} })
  assert.equal(store.get(meta, '1').status, 'processed', '不重复导入')
  assert.equal(readFileSync(brokenFile, 'utf8'), '{broken')
})

test('回查工具分页限制、长消息续读与即时权限检查，不跨聊天、不推进未提供位置', async () => {
  const store = createMessageStore(), tools = new Map()
  try {
    store.put(meta, { ...item(1), body: '长'.repeat(15000) })
    store.put({ ...meta, peerId: '70002' }, { ...item(2), body: '另一个聊天的秘密' })
    const config = { groupMode: 'open' }, record = { ...meta, sessionId: 'main' }
    registerMessageTool({ register: tool => tools.set(tool.name, tool) }, {
      selfId: meta.selfId, find: id => id === 'main' ? record : null, messageStore: store,
    }, config)
    const exec = { agent: { session: { id: 'main' } } }, tool = tools.get('qq_history')
    const first = await tool.execute({}, exec)
    assert.equal(first.messages.length, 1)
    assert.equal(first.messages[0].text.length, 12000)
    const second = await tool.execute({ seq: first.messages[0].seq, offset: 12000 }, exec)
    assert.equal(second.messages[0].text.length, 3000)
    assert.equal(store.pending(meta).length, 1)
    config.groupMode = 'disabled'
    await assert.rejects(tool.execute({}, exec), /获准/)
  } finally { store.close() }
})
