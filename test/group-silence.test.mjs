import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInbound } from '../src/inbound.js'
import { waitFor, textOf } from './mock-dsh.mjs'

const cases = [
  { name: '保活期里的普通消息', text: '这只是后续闲聊', atMe: false, addressedMaySilent: false, maySilent: true },
  { name: '真实点名', text: '第二条消息', atMe: true, addressedMaySilent: false, maySilent: false },
  { name: '允许沉默的点名', text: '第二条消息', atMe: true, addressedMaySilent: true, maySilent: true },
  { name: '叫名字', text: '测试机器人，看看这里', atMe: false, addressedMaySilent: false, maySilent: false },
]

for (const [i, scenario] of cases.entries()) {
  test(`回复间隔补发保留回复要求：${scenario.name}`, async t => {
    const delivered = [], warnings = []
    const record = { scope: 'group', peerId: String(73001 + i), sessionId: `silence-${i}`,
      history: [], recent: [], queue: Promise.resolve(), initialContextDelivered: true,
      agent: { followup: message => delivered.push(message), whenIdle: async () => {} } }
    const manager = { selfId: '9', selfName: '测试机器人', findByPeer: () => record,
      obtain: async () => record, enqueue: (_record, task) => { record.queue = record.queue.then(task); return record.queue } }
    const config = { groupMode: 'open', requireMention: true, groupWakeMs: 10000, groupReplyGapMs: 100,
      groupWakeQuestion: false, mergeWindowMs: 0, historyLimit: 0, chatLog: false,
      addressedMaySilent: scenario.addressedMaySilent }
    const inbound = createInbound({ config, manager, client: { call: async () => ({}) },
      logger: { warn: (...args) => warnings.push(args) } })
    t.after(() => inbound.dispose())
    const event = (id, text, atMe) => ({ post_type: 'message', message_type: 'group', self_id: 9,
      group_id: Number(record.peerId), user_id: 10001, message_id: id, sender: { nickname: '甲', user_id: 10001 },
      message: [...(atMe ? [{ type: 'at', data: { qq: '9' } }] : []), { type: 'text', data: { text } }] })
    await inbound(event(1, '第一条消息', true))
    await record.queue
    assert.equal(delivered.length, 1)
    await inbound(event(2, scenario.text, scenario.atMe))
    assert.equal(delivered.length, 1, '第二条先等待回复间隔')
    await waitFor(() => delivered.length === 2)
    await record.queue
    assert.equal(delivered[1].source.qqMaySilent, scenario.maySilent)
    assert.doesNotMatch(textOf(delivered[1]), /\[SILENT\]/)
    assert.deepEqual(warnings, [])
  })
}
