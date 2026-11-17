import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOutbound, extractText } from '../src/outbound.js'
import { stripSilentMark } from '../src/prompts.js'

test('明确沉默标记出现在正文任意位置，落定消息整条不发送且不扣主动额度', async () => {
  const record = { sessionId: 'silent-session', scope: 'private', _proactiveAt: 1 }
  const sent = [], silent = []
  const outbound = createOutbound({
    manager: { find: id => id === record.sessionId ? record : null },
    config: { streamReply: false }, logger: {},
    send: async (_record, text) => { sent.push(text); return { ok: true } },
    wake: { noteProactiveSilent: () => silent.push(true) },
  })
  const cases = [
    { content: [{ type: 'text', text: '[SILENT]' }] },
    { content: [{ type: 'text', text: '这次不发言。\n[SILENT]' }] },
    { content: [{ type: 'reasoning', text: '想一下' }, { type: 'text', text: '[SILENT]\n不发送后面的文字。' }] },
    { content: [{ type: 'text', text: '前文[SILENT]后文' }] },
  ]
  for (const message of cases) {
    await outbound({ id: record.sessionId }, { type: 'turn/start' })
    assert.ok(extractText(message).includes('[SILENT]'))
    await outbound({ id: record.sessionId }, { type: 'assistant/message', data: { message } })
  }
  assert.deepEqual(sent, [])
  assert.equal(silent.length, cases.length)
})

test('send 层的老兜底还在：整条只有标记时剥成空', () => {
  assert.equal(stripSilentMark('[SILENT]'), '')
  assert.equal(stripSilentMark('  [SILENT]  '), '')
})
