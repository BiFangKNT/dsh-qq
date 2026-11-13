import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools } from '../src/tools.js'

const exec = { agent: { session: { id: 'main' } } }
function fixture(t, { scope = 'private', extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qq-tool-send-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = { cwd: root, replyToPrivate: true, privateMode: 'open', groupMode: 'open',
    ownerIds: ['10001'], ...extra }
  const source = { selfId: '90001', scope, peerId: '10001', sessionId: 'main', lastSentMessageId: 11 }
  const group = { selfId: '90001', scope: 'group', peerId: '70001', sessionId: 'group', lastSentMessageId: 22 }
  const privateChat = { selfId: '90001', scope: 'private', peerId: '10002', sessionId: 'private', lastSentMessageId: 33 }
  const records = [source, group, privateChat], tools = new Map(), calls = [], notes = [], memories = [], activity = [], proactive = [], synthesis = []
  const manager = { selfId: '90001', find: id => records.find(record => record.sessionId === id),
    findByPeer: (kind, peerId) => records.find(record => record.scope === kind && record.peerId === String(peerId)),
    memory: { noteSent: (...args) => memories.push(args) } }
  const h = { config, source, group, privateChat, manager, tools, calls, notes, memories, activity, proactive, synthesis,
    response: { message_id: 71 }, beforeReply: null, beforeSynthesis: null }
  registerTools({ get: name => name === 'tools' ? { register: tool => tools.set(tool.name, tool) } : null }, {
    config, manager, home: root, logger: { info() {}, warn() {}, debug() {} },
    client: { async call(action, params) {
      calls.push({ action, params })
      await h.beforeReply?.()
      if (h.response instanceof Error) throw h.response
      return h.response
    } },
    noteSelfSaid: (...args) => notes.push(args), wake: {
      noteOutbound: record => activity.push(record), noteProactiveDelivered: record => proactive.push(record),
    },
    synthesize: async text => { synthesis.push(text); await h.beforeSynthesis?.(); return Buffer.from('mock audio') },
  })
  h.send = (name, to) => tools.get(name).execute({ text: '测试发送内容', ...(to === undefined ? {} : { to }) }, exec)
  return h
}

for (const name of ['qq_send', 'qq_send_voice']) {
  for (const scope of ['private', 'group']) {
    test(`${name}：${scope} 普通账号可发当前聊天，显式当前目标不要求授权身份`, async t => {
      const h = fixture(t, { scope, extra: { ownerIds: [] } })
      for (const to of [undefined, `${scope === 'group' ? 'group' : 'user'}:10001`]) {
        assert.equal((await h.send(name, to)).ok, true)
      }
      assert.equal(h.calls.length, 2)
      assert.ok(h.calls.every(call => call.action === `send_${scope}_msg` && call.params[scope === 'group' ? 'group_id' : 'user_id'] === 10001))
      assert.equal(h.source.lastSentMessageId, 71)
      assert.ok(h.notes.every(([record]) => record === h.source))
    })
  }

  test(`${name}：普通账号和群内授权账号均不能跨聊天发送，拒绝前不合成或外发`, async t => {
    for (const [scope, ownerIds] of [['private', []], ['group', ['10001']]]) {
      const h = fixture(t, { scope, extra: { ownerIds } })
      for (const to of ['group:70001', 'user:10002']) await assert.rejects(h.send(name, to), /授权账号私聊/)
      assert.equal(h.calls.length, 0)
      assert.equal(h.synthesis.length, 0)
      assert.equal(h.notes.length, 0)
    }
  })

  test(`${name}：授权私聊向其他群或私聊发送，只更新目标记录`, async t => {
    const h = fixture(t)
    for (const [to, record] of [['group:70001', h.group], ['user:10002', h.privateChat]]) {
      assert.equal((await h.send(name, to)).ok, true)
      assert.equal(h.notes.at(-1)[0], record)
      assert.equal(h.memories.at(-1)[0], record)
      assert.equal(h.memories.at(-1)[2], 71)
      assert.equal(h.activity.at(-1), record)
      assert.equal(record.lastSentMessageId, 71)
    }
    assert.equal(h.source.lastSentMessageId, 11)
    assert.ok(h.notes.every(([record]) => record !== h.source))
    assert.equal(h.proactive.length, 0, '跨聊天发送不冒充目标聊天自身的主动轮交付')
  })

  test(`${name}：有符号消息 ID 和零值可确认、记账并作为默认撤回目标`, async t => {
    const h = fixture(t)
    for (const id of [-2147483648, -71, 0, 2147483647]) {
      for (const response of [{ message_id: id }, { data: { message_id: String(id) } }]) {
        h.response = response
        const result = await h.send(name, 'group:70001')
        assert.equal(result.ok, true)
        assert.equal(result.messageId, id)
        assert.equal(h.group.lastSentMessageId, id)
        assert.equal(h.memories.at(-1)[0], h.group)
        assert.equal(h.memories.at(-1)[2], id)
        const recalled = await h.tools.get('qq_recall').execute({}, { agent: { session: { id: 'group' } } })
        assert.equal(recalled.ok, true)
        assert.deepEqual(h.calls.at(-1), { action: 'delete_msg', params: { message_id: id } })
      }
    }
    assert.equal(h.source.lastSentMessageId, 11)
    assert.ok(h.notes.every(([record]) => record === h.group))
  })

  test(`${name}：当前或目标聊天关闭、名单不符、账号身份变化均不发送`, async t => {
    for (const config of [
      { privateMode: 'disabled' }, { replyToPrivate: false }, { privateMode: 'allowlist', privateAllow: [] },
      { groupMode: 'disabled' }, { groupMode: 'allowlist', groupAllow: [] },
      { peerBots: ['10001'], botChatEnabled: false },
    ]) {
      const h = fixture(t, { extra: config })
      await assert.rejects(h.send(name, 'group:70001'), /未获准/)
      assert.equal(h.calls.length, 0)
      assert.equal(h.synthesis.length, 0)
    }
    const h = fixture(t)
    h.manager.selfId = '90002'
    await assert.rejects(h.send(name, 'group:70001'), /未获准/)
    h.manager.selfId = '90001'
    h.config.peerBots = ['10002']
    await assert.rejects(h.send(name, 'user:10002'), /未获准/)
    assert.equal(h.calls.length, 0)
    assert.equal(h.synthesis.length, 0)
  })

  test(`${name}：非法目标在合成和外发前被拒绝`, async t => {
    const h = fixture(t)
    for (const to of ['group:0', 'user:-1', 'group:9007199254740993', 'other:10001', {}, null]) {
      await assert.rejects(h.send(name, to), /to 格式/)
    }
    assert.equal(h.calls.length, 0)
    assert.equal(h.synthesis.length, 0)
  })

  test(`${name}：内容检查期间撤销授权，准备下一阶段前重新检查`, async t => {
    const h = fixture(t)
    const sending = h.send(name, 'group:70001')
    h.config.ownerIds = []
    await assert.rejects(sending, /授权账号私聊/)
    assert.equal(h.synthesis.length, 0)
    assert.equal(h.calls.length, 0)
    assert.equal(h.notes.length, 0)
  })

  test(`${name}：冷目标发送不创建 Agent，也不污染发起聊天的历史或撤回目标`, async t => {
    const h = fixture(t)
    h.manager.findByPeer = () => null
    h.manager.obtain = () => assert.fail('不能为发送记账启动 Agent')
    assert.equal((await h.send(name, 'group:70001')).ok, true)
    assert.equal(h.calls.length, 1)
    assert.equal(h.notes.length, 0)
    assert.equal(h.memories.length, 0)
    assert.equal(h.source.lastSentMessageId, 11)
  })

  test(`${name}：失败或缺少消息 ID 不写成功记录，不自动重试`, async t => {
    const h = fixture(t)
    const responses = [{}, ...[null, '', ' ', false, true, 1.5, Number.MAX_SAFE_INTEGER + 1].map(message_id => ({ message_id })), new Error('模拟回执丢失')]
    for (const response of responses) {
      h.response = response
      if (name === 'qq_send_voice' && response instanceof Error) await assert.rejects(h.send(name, 'group:70001'), /回执丢失/)
      else assert.equal((await h.send(name, 'group:70001')).ok, false)
    }
    assert.equal(h.calls.length, responses.length)
    assert.equal(h.notes.length, 0)
    assert.equal(h.memories.length, 0)
    assert.equal(h.source.lastSentMessageId, 11)
    assert.equal(h.group.lastSentMessageId, 22)
  })
}

test('默认撤回缺少消息 ID 时不调用协议端', async t => {
  const h = fixture(t)
  delete h.source.lastSentMessageId
  await assert.rejects(h.tools.get('qq_recall').execute({}, exec), /找不到要撤回的消息/)
  assert.equal(h.calls.length, 0)
})

test('语音合成期间撤销授权或关闭目标，发送前再次检查，不外发或记成功', async t => {
  for (const revoke of [h => { h.config.ownerIds = [] }, h => { h.config.groupMode = 'disabled' }, h => { h.config.privateMode = 'disabled' }]) {
    const h = fixture(t)
    h.beforeSynthesis = () => revoke(h)
    await assert.rejects(h.send('qq_send_voice', 'group:70001'), /授权账号私聊|未获准/)
    assert.equal(h.synthesis.length, 1)
    assert.equal(h.calls.length, 0)
    assert.equal(h.notes.length, 0)
  }
})

test('工具说明如实描述词库来源和语音平台限制，不声称内置固定数量的梗', t => {
  const h = fixture(t)
  assert.match(h.tools.get('qq_meme').description, /未配置|无法查询/)
  assert.doesNotMatch(h.tools.get('qq_meme').description, /6668|毫秒级|先接梗、别科普/)
  assert.match(h.tools.get('qq_send_voice').description, /仅 Windows|其他平台/)
})
