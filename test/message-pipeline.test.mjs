import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createMockEnvironment } from './mock-environment.mjs'
import { waitFor, textOf } from './mock-dsh.mjs'
import { createMessageStore } from '../src/message-store.js'

const meta = { selfId: '10001', scope: 'private', peerId: '11001' }
async function environment(t, options) {
  const env = await createMockEnvironment({ autoReply: false, ...options })
  t.after(async () => { await env.close(); await rm(env.root, { recursive: true, force: true }) })
  return { env, store: createMessageStore(join(env.root, 'dsh-qq')) }
}

test('容量失败只反馈一次、不轮询重压缩；下一次交付跳过过大积压，完整原文可查', async t => {
  const { env, store } = await environment(t, { llm: {
    prepareCall: async config => ({ config: { maxTokens: 100, ...config }, context: { contextWindow: 10000 } }),
  } })
  const compaction = env.host.ctx.get('compaction')
  compaction.config = { thresholdRatio: 0.8, headroomTokens: 100 }
  env.emitMessage({ text: '先完成一轮，建立已有历史', messageId: 1 })
  await waitFor(() => store.get(meta, '1')?.status === 'processed')
  let compactCalls = 0
  const compact = compaction.compactNow.bind(compaction)
  compaction.compactNow = (...args) => { compactCalls++; return compact(...args) }
  const large = '单条触发不能被截断。'.repeat(10000)
  env.emitMessage({ text: large, messageId: 2 })
  await waitFor(() => store.blocked(meta))
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(compactCalls, 1)
  assert.equal(store.get(meta, '2').body.includes(large), true)
  assert.equal(store.get(meta, '2').status, 'pending')
  assert.equal(env.napcat.calls.filter(call => call.action === 'send_private_msg').length, 1, '只发一次固定错误说明')
  env.emitMessage({ text: '本次能放下的新消息', messageId: 3 })
  await waitFor(() => store.get(meta, '3')?.status === 'processed')
  assert.equal(store.get(meta, '2').status, 'omitted')
  const agent = [...env.host.agents.values()][0]
  assert.equal(agent.received.length, 2)
  assert.match(textOf(agent.received.at(-1)), /未提供/)
  assert.doesNotMatch(textOf(agent.received.at(-1)), /先完成一轮|单条触发不能被截断/)
  await env.reload()
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal([...env.host.agents.values()].reduce((n, agent) => n + agent.received.length, 0), 0, '重启不加载已完成聊天或自动重放')
  assert.equal(store.get(meta, '2').body.includes(large), true)
})

test('分段发送保存全部计划与进度，失败后不重做主模型，未发段落不记为已经发送', async t => {
  const { env, store } = await environment(t, { config: { streamReply: false, textChunkLimit: 200, splitDelayMs: 200 } })
  env.emitMessage({ text: '测试分段', messageId: 10, steps: [{ type: 'text', text: '第一段'.repeat(66) + '\n' + '后续'.repeat(220) }] })
  await waitFor(() => store.sends(meta).some(row => row.status === 'sent'))
  env.napcat.failNext('send_private_msg', { wording: '模拟第二段发送被拒绝' })
  await waitFor(() => store.get(meta, '10')?.status === 'processed')
  const sends = store.sends(meta)
  assert.equal(sends.filter(row => row.status === 'sent').length, 1)
  assert.equal(sends.filter(row => row.status === 'rejected').length, 1)
  assert.ok(sends.some(row => row.status === 'queued'), '后续未发段落仍有记录')
  const calls = env.napcat.calls.filter(call => call.action === 'send_private_msg').length
  await env.reload()
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(env.napcat.calls.filter(call => call.action === 'send_private_msg').length, calls)
  assert.equal(store.get(meta, '10').status, 'processed')
})
