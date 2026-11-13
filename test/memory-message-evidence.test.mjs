import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemory } from '../src/memory.js'
import { createMessageStore } from '../src/message-store.js'

for (const toolName of ['qq_history', 'qq_messages', 'qq_group_history', 'qq_private_history']) {
  test(`记忆维护复用容量检查，遗漏说明与 ${toolName} 回查不算新用户依据`, async t => {
    const home = mkdtempSync(join(tmpdir(), 'qq-memory-evidence-'))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    const record = { selfId: '10001', scope: 'private', peerId: '11001', sessionId: 'main' }
    const messages = createMessageStore(), inputs = []
    let checks = 0
    const memory = createMemory({ home, config: { provider: 'test', model: 'test' }, messageStore: messages,
      capacity: { check: async () => { checks++ } }, getLlm: () => ({ async *stream(options) {
        inputs.push(JSON.parse(options.messages[0].content[0].text))
        yield { type: 'text-delta', index: 0, text: '{"changes":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }) })
    try {
      messages.put(record, { id: 'new-1', body: '这件事已经完成了', source: {}, receivedAt: 1 })
      const events = [
        { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: '遗漏范围说明，不是用户原话' }],
          source: { kind: 'user', qqMessages: [{ id: 'new-1' }] } } },
        { seq: 1, type: 'tool/call', data: { name: toolName, callId: 'read-old', arguments: '{}' } },
        { seq: 2, type: 'tool/result', data: { message: { toolCallId: 'read-old', content: [{ type: 'text', text: '旧事项早就结束了' }] } } },
        { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ]
      record.agent = { session: { snapshotEvents: () => events } }
      memory.onSessionEvent(record, record.agent.session, events[3])
      await memory.wait(record)
      assert.equal(checks, 1)
      assert.equal(inputs[0].evidence.length, 1)
      assert.match(JSON.stringify(inputs[0].evidence), /这件事已经完成了/)
      assert.doesNotMatch(JSON.stringify(inputs[0].evidence), /遗漏范围说明|旧事项早就结束/)
    } finally { memory.stop(); messages.close() }
  })
}
