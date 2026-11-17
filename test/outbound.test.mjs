import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutbound, extractText } from '../src/outbound.js'
import { sendToolMessage } from '../src/tool-result.js'

function harness(config = {}, send) {
  const record = { selfId: '10001', scope: 'private', peerId: '11001', sessionId: 's1', label: '测试会话' }
  const sent = [], silent = [], activity = []
  const outbound = createOutbound({ manager: { find: id => id === 's1' ? record : null },
    config: { streamReply: false, ...config }, logger: { info() {}, warn() {} },
    wake: { noteOutbound: () => activity.push(true), noteProactiveSilent: () => silent.push(true) },
    send: async (_record, text) => { sent.push(text); return send ? send(text) : { ok: true } } })
  const fire = (type, data = {}) => outbound({ id: 's1' }, { type, data })
  const text = text => fire('assistant/message', { message: { content: [{ type: 'text', text }] } })
  const chunk = text => fire('assistant/chunk', { chunk: { type: 'text-delta', text } })
  const tool = async (value, outcome = { message_id: 0 }, target = record) => {
    await fire('tool/call', { name: 'qq_send', arguments: JSON.stringify({ text: value }) })
    return sendToolMessage({ call: async () => { if (outcome instanceof Error) throw outcome; return outcome } },
      'send_private_msg', {}, {}, { record, target, text: value })
  }
  return { record, sent, silent, activity, fire, text, chunk, tool }
}

test('只读取 text 正文，不从 reasoning 补话；结构化工具调用消息不外发', async () => {
  const h = harness()
  assert.equal(extractText({ content: [{ type: 'reasoning', text: '推理' }] }), '')
  for (const content of [[], [{ type: 'reasoning', text: '不能发送的推理' }],
    [{ type: 'text', text: '准备调用' }, { type: 'tool-call', name: 'read' }]]) {
    await h.fire('assistant/message', { message: { content } })
  }
  await h.fire('assistant/chunk', { chunk: { type: 'reasoning-delta', text: '不发送' } })
  assert.deepEqual(h.sent, [])
  await h.fire('assistant/message', { message: { content: [
    { type: 'reasoning', text: '不发送' }, { type: 'text', text: 'Hello!' },
  ] } })
  assert.deepEqual(h.sent, ['Hello!'])
})

test('只按明确沉默标记处理，主动轮也不凭口吻删正文', async () => {
  const h = harness()
  h.record._proactiveAt = Date.now()
  await h.text('这一条不发。[SILENT]')
  await h.text('[SILENT]')
  assert.deepEqual(h.sent, [])
  assert.equal(h.silent.length, 2)
  for (const value of ['保持沉默也是一种选择。', '先这样，明天再讨论。', '结束这轮以后继续测试。', '请别打扰正在休息的人。']) {
    await h.text(value)
  }
  assert.equal(h.sent.length, 4)
  await h.fire('turn/end', { reason: { kind: 'completed' } })
  assert.equal(h.record._proactiveAt, 0)
})

test('发送工具只在执行后按相同内容去重，调用事件不屏蔽失败说明', async () => {
  const h = harness()
  await h.fire('tool/call', { name: 'qq_send' })
  await h.text('发送失败，请检查连接。')
  await h.tool('工具实际发送的内容')
  await h.text('工具实际发送的内容')
  await h.text('这是不同的补充说明。')
  assert.deepEqual(h.sent, ['发送失败，请检查连接。', '这是不同的补充说明。'])
})

for (const state of ['not-sent', 'rejected', 'uncertain', 'missing-id']) {
  test(`工具结果 ${state}：失败说明可发，未确认的同文不自动补发`, async () => {
    const h = harness()
    const error = Object.assign(new Error('private details'), { onebotDelivery: state })
    await assert.rejects(h.tool('这段是尝试发送的原文', state === 'missing-id' ? {} : error))
    await h.text('这段是尝试发送的原文')
    await h.text('发送结果需要核对，请检查记录。')
    assert.deepEqual(h.sent, ['not-sent', 'rejected'].includes(state)
      ? ['这段是尝试发送的原文', '发送结果需要核对，请检查记录。'] : ['发送结果需要核对，请检查记录。'])
  })
}

test('跨聊天发送不抑制当前正文，多次工具发送只去掉对应的重复前缀', async () => {
  const h = harness()
  await h.tool('目标群内容', { message_id: -71 }, { ...h.record, scope: 'group', peerId: '70001' })
  await h.text('目标群内容')
  await h.tool('第一段')
  await h.tool('第二段')
  await h.text('第一段\n第二段\n另外还有一件事。')
  assert.deepEqual(h.sent, ['目标群内容', '另外还有一件事。'])
})

test('长短不同的工具回复以不同空白连接时，逐段去重并保留补充', async () => {
  for (const uncertain of [false, true]) {
    for (const separator of ['\n', '\n\n', ' \n\t']) {
      for (const supplement of ['', '新的补充。']) {
        const h = harness()
        const parts = ['第一段', '这是比较长的第二段', '第三段也有不同长度']
        for (const part of parts) {
          if (uncertain) await assert.rejects(h.tool(part, {}), /未确认/)
          else await h.tool(part)
        }
        await h.text([...parts, ...(supplement ? [supplement] : [])].join(separator))
        assert.deepEqual(h.sent, supplement ? [supplement] : [])
      }
    }
  }
  const h = harness()
  await h.tool('第一段')
  await h.text('第一段落的内容不同，不应该被截去。')
  assert.deepEqual(h.sent, ['第一段落的内容不同，不应该被截去。'])
})

test('上一轮发送状态结束时清除，相同回复下一轮仍可发送', async () => {
  const h = harness()
  await h.tool('收到')
  await h.text('收到')
  await h.fire('turn/end', { reason: { kind: 'completed' } })
  await h.fire('turn/start')
  await h.text('收到')
  assert.deepEqual(h.sent, ['收到'])
})

test('迟到的工具回执不会给更换后的会话加入去重记录', async () => {
  const h = harness(), gate = Promise.withResolvers()
  const pending = sendToolMessage({ call: () => gate.promise }, 'send_private_msg', {}, {},
    { record: h.record, text: '上个会话的内容' })
  h.record.sessionId = 's2'
  gate.resolve({ message_id: 1 })
  await pending
  await h.text('上个会话的内容')
  assert.deepEqual(h.sent, ['上个会话的内容'])
})

test('同一会话上一轮的迟到回执不会抑制新一轮正文', async () => {
  const h = harness(), gate = Promise.withResolvers()
  const pending = sendToolMessage({ call: () => gate.promise }, 'send_private_msg', {}, {},
    { record: h.record, text: '上一轮的内容' })
  await h.fire('turn/end', { reason: { kind: 'completed' } })
  await h.fire('turn/start')
  await h.tool('新一轮工具内容')
  gate.resolve({ message_id: 1 })
  await pending
  await h.text('上一轮的内容')
  await h.text('新一轮工具内容')
  assert.deepEqual(h.sent, ['上一轮的内容'])
})

test('流式和最终正文按原始字符位置衔接，英文代码不被删改', async () => {
  const h = harness({ streamReply: true, streamMaxChunks: 2 })
  const parts = ['Hello world!\n', '第一句正常正文。', '\n第二句也保留。']
  for (const part of parts) await h.chunk(part)
  await h.text(parts.join(''))
  assert.deepEqual(h.sent, ['Hello world!', '第一句正常正文。', '第二句也保留。'])
})

test('发送工具后等待完整正文去重，流式补充仍能发送', async () => {
  const h = harness({ streamReply: true })
  await h.tool('刚才发送的内容。')
  await h.chunk('刚才发送的内容。\n还有一些补充。')
  assert.deepEqual(h.sent, [])
  await h.text('刚才发送的内容。\n还有一些补充。')
  assert.deepEqual(h.sent, ['还有一些补充。'])
})

test('流式失败后停止同条消息补发；下一条不同的失败说明仍可发送', async () => {
  const h = harness({ streamReply: true }, () => ({ ok: false, reason: 'uncertain' }))
  await h.chunk('第一段测试消息。')
  await h.chunk('第二段不应该发送。')
  await h.text('第一段测试消息。第二段不应该发送。')
  await h.text('结果未知，请检查。')
  assert.deepEqual(h.sent, ['第一段测试消息。', '结果未知，请检查。'])
  assert.equal(h.activity.length, 0)
})

test('群聊不按流式外发，重复最终事件不重发，下一轮不受影响', async () => {
  const h = harness({ streamReply: true })
  h.record.scope = 'group'
  await h.chunk('测试消息不能抢先发送。')
  assert.deepEqual(h.sent, [])
  await h.text('测试消息不能抢先发送。')
  await h.text('测试消息不能抢先发送。')
  await h.fire('turn/end', { reason: { kind: 'completed' } })
  await h.text('测试消息不能抢先发送。')
  assert.equal(h.sent.length, 2)
})

test('敏感拦截后不发送后续正文或重复错误，下一轮恢复', async () => {
  const h = harness({}, () => ({ ok: false, reason: 'sensitive-content', noticeSent: true }))
  await h.text('拦截这一条')
  await h.text('后续正文')
  await h.fire('turn/end', { reason: { kind: 'error', error: { message: 'sensitive', code: 'QQ_SENSITIVE_CONTENT' } } })
  assert.deepEqual(h.sent, ['拦截这一条'])
  await h.fire('turn/start')
  await h.text('下一轮正文')
  assert.equal(h.sent.length, 2)
})
