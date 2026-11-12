import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../src/index.js'
import { createInbound } from '../src/inbound.js'
import { SessionManager } from '../src/session.js'
import { createAddressClassifier } from '../src/address-classifier.js'
import { createMockDsh } from './mock-dsh.mjs'
import { readCommandText, readMessage } from '../src/onebot/segment.js'

const logger = { info() {}, warn() {}, debug() {} }
async function harness(t, classified) {
  const root = await mkdtemp(join(tmpdir(), 'qq-commands-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const host = createMockDsh({ home: root })
  const config = Config({ cwd: root, isolateByPeer: false, ownerIds: [], chatLog: false,
    privateMode: 'open', groupMode: 'open', requireMention: false, mergeWindowMs: 0,
    groupWakeMs: 60000, groupWakeIdleMs: 0, groupReplyGapMs: 0, groupRepliesPerWindow: 0,
    addressClassifierEnabled: classified, addressClassifierProvider: 'test', addressClassifierModel: 'judge' })
  const manager = new SessionManager({ ctx: host.ctx, agents: host.ctx.agents, selfId: '10001', config, logger, home: root })
  const calls = [], sent = []
  const llm = { async *stream(options) {
    calls.push(options)
    yield { type: 'text-delta', index: 0, text: 'yes' }
  } }
  const classifier = classified ? createAddressClassifier({ home: root, config, llm, logger }) : undefined
  const inbound = createInbound({ config, manager, logger, addressClassifier: classifier,
    client: { call: async () => ({}) }, send: async (_record, text) => sent.push(text) })
  t.after(async () => { inbound.dispose(); manager.stop(); await host.dispose() })
  const record = await manager.obtain({ scope: 'group', peerId: '22001', label: '测试群' })
  let id = 0
  const receive = async (message, scope = 'group') => {
    await inbound({ post_type: 'message', message_type: scope, self_id: 10001, user_id: 11001,
      group_id: 22001, message_id: ++id, sender: { user_id: 11001, nickname: '测试用户' }, message })
    const current = await manager.obtain({ scope, peerId: scope === 'group' ? '22001' : '11001', label: '测试聊天' })
    await current.queue
    return current
  }
  return { receive, record, config, calls, sent }
}
const mention = text => [{ type: 'at', data: { qq: '10001', name: '任意显示名' } }, { type: 'text', data: { text } }]

for (const classified of [false, true]) {
  test(`群聊通过 @ 目标账号识别全部命令，直接回复且不调用模型（分类器=${classified}）`, async t => {
    const h = await harness(t, classified)
    h.config.requireMention = true
    for (const command of ['/status', '#status', '/cwd', '#cwd', '/help', '#help', '/new', '#new', '/reset', '#reset']) {
      const count = h.sent.length, oldId = h.record.sessionId
      await h.receive(mention(` ${command}`))
      assert.equal(h.sent.length, count + 1, command)
      assert.equal(h.record.agent.received.length, 0, command)
      if (/new|reset/.test(command)) assert.notEqual(h.record.sessionId, oldId)
    }
    await h.receive('[CQ:at,qq=10001] ／STATUS ')
    assert.equal(h.sent.length, 11)
    assert.match(h.sent.at(-1), /会话：/)
    assert.equal(h.calls.length, 0)
  })

  test(`群聊未 @ 时不执行命令，保活和关闭必须 @ 均不例外（分类器=${classified}）`, async t => {
    const h = await harness(t, classified)
    await h.receive(mention(' /status'))
    const sent = h.sent.length, oldId = h.record.sessionId
    await h.receive('/new')
    assert.equal(h.record.sessionId, oldId)
    assert.equal(h.sent.length, sent)
    assert.equal(h.record.agent.received.length, 1)
    assert.equal(h.calls.length, classified ? 1 : 0)
    h.config.requireMention = true
    await h.receive('/status')
    assert.equal(h.sent.length, sent)
    assert.equal(h.record.agent.received.length, 2)
  })

  test(`私聊仍可直接执行命令（分类器=${classified}）`, async t => {
    const h = await harness(t, classified)
    const record = await h.receive(' /STATUS ', 'private')
    assert.equal(h.sent.length, 1)
    assert.match(h.sent[0], /会话：/)
    assert.equal(record.agent.received.length, 0)
    assert.equal(h.calls.length, 0)
  })

  test(`显示名、其他 @ 和普通句子不能误触发，聊天文本保持原样（分类器=${classified}）`, async t => {
    const h = await harness(t, classified), oldId = h.record.sessionId
    const cases = [
      '@任意显示名 /new',
      [{ type: 'at', data: { qq: '11002', name: '机器人' } }, { type: 'text', data: { text: ' /new' } }],
      '[CQ:at,qq=10001][CQ:at,qq=11002] /new',
      '[CQ:at,qq=all][CQ:at,qq=10001] /new',
      mention(' 请执行 /new'),
      [{ type: 'text', data: { text: '/new ' } }, { type: 'at', data: { qq: '10001' } }],
    ]
    for (const message of cases) await h.receive(message)
    assert.equal(h.sent.length, 0)
    assert.equal(h.record.sessionId, oldId)
    assert.equal(h.record.agent.received.length, cases.length)
    for (const [index, message] of cases.entries()) {
      const text = readMessage(message, { selfId: '10001', selfName: '机器人' }).text
      assert.ok(JSON.stringify(h.record.agent.received[index]).includes(text), text)
    }
  })

  test(`命令仍受白名单和同类机器人开关限制（分类器=${classified}）`, async t => {
    const h = await harness(t, classified)
    h.config.groupMode = 'allowlist'
    h.config.groupAllow = []
    await h.receive(mention(' /status'))
    h.config.groupMode = 'open'
    h.config.peerBots = ['11001']
    h.config.botChatEnabled = false
    await h.receive(mention(' /status'))
    assert.equal(h.sent.length, 0)
    assert.equal(h.calls.length, 0)
    assert.equal(h.record.agent.received.length, 0)
  })
}

test('命令提取兼容引用与前置空白，不把媒体或缺失身份的 @ 当作命令', () => {
  const options = { selfId: '10001', requireMention: true }
  const message = [{ type: 'reply', data: { id: '123' } }, { type: 'text', data: { text: ' \n' } }, ...mention(' /status ')]
  assert.equal(readCommandText(message, options), '/status')
  assert.equal(readCommandText('[CQ:reply,id=123][CQ:at,qq=10001] /status', options), '/status')
  assert.equal(readCommandText([...mention(' /new'), { type: 'image', data: {} }], options), '')
  assert.equal(readCommandText([{ type: 'at', data: {} }, { type: 'text', data: { text: '/new' } }], { requireMention: true }), '')
})
