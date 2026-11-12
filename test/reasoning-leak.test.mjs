import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOutbound, hasToolUse } from '../src/outbound.js'

test('hasToolUse 识别工具块，不误伤正文和 reasoning', () => {
  for (const type of ['tool_use', 'tool-call', 'function_call']) {
    assert.equal(hasToolUse({ content: [{ type }] }), true)
  }
  assert.equal(hasToolUse({ content: [{ type: 'text', text: '正文' }, { type: 'reasoning', text: '推理' }] }), false)
  assert.equal(hasToolUse(null), false)
})

for (const scope of ['group', 'private']) {
  for (const streamReply of [false, true]) {
    test(scope + ' / 流式 ' + streamReply + '：推理不外发，空正文和沉默正常结束', async () => {
      const sent = [], warnings = []
      const record = { sessionId: 's1', scope, label: '测试会话' }
      const outbound = createOutbound({ manager: { find: () => record }, config: { streamReply, streamMaxChunks: 2 },
        logger: { info() {}, warn: (...args) => warnings.push(args) }, send: async (_record, text) => sent.push(text) })
      const fire = (type, data) => outbound({ id: 's1' }, { type, sessionId: 's1', data })
      for (const proactive of [false, true]) {
        for (const text of ['', 'Hmm 这句要短一点。', '[SILENT]', '这次就不接话。[SILENT]']) {
          record._proactiveAt = proactive ? Date.now() : 0
          await fire('turn/start', {})
          await fire('assistant/chunk', { chunk: { type: 'reasoning-delta', text: '你说得对，这是一段不应外发的推理。' } })
          await fire('assistant/message', { message: { content: [
            { type: 'reasoning', text: '你说得对，这是一段不应外发的推理。' }, { type: 'text', text },
          ] } })
          await fire('turn/end', { reason: { kind: 'completed' } })
          assert.deepEqual(sent, [])
        }
      }
      await fire('assistant/message', { message: { content: [
        { type: 'reasoning', text: '先调用工具检查。' }, { type: 'tool-call', name: 'read' },
      ] } })
      assert.deepEqual(sent, [])
      await fire('assistant/message', { message: { content: [
        { type: 'reasoning', text: '这段推理不应该发。' }, { type: 'text', text: '事情已经处理好了。' },
      ] } })
      assert.deepEqual(sent, ['事情已经处理好了。'])
      assert.deepEqual(warnings, [])
    })
  }
}
