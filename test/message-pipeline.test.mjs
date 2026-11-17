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
  assert.ok(sends.some(row => row.status === 'not-sent'), '后续未调用段落明确记为未发送')
  const calls = env.napcat.calls.filter(call => call.action === 'send_private_msg').length
  await env.reload()
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(env.napcat.calls.filter(call => call.action === 'send_private_msg').length, calls)
  assert.equal(store.get(meta, '10').status, 'processed')
})

test('摘要失败只通知一次，保留批次进度；新触发后续接交付且只把近期原文列为记忆依据', async t => {
  let calls = 0, fail = true
  const { env, store } = await environment(t, { config: { backlogSummaryEnabled: true }, llm: {
    prepareCall: async config => ({ config: { maxTokens: 512, ...config }, context: { contextWindow: 18000 } }),
    async *stream(options) {
      assert.equal(options.purpose, 'qq-backlog-summary')
      assert.deepEqual(options.tools, [])
      calls++
      if (fail && calls === 2) throw new Error('模拟摘要网络中断')
      yield { type: 'text-delta', index: 0, text: `先前聊天摘要${calls}` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } })
  env.host.ctx.get('compaction').config = { thresholdRatio: 0.8, headroomTokens: 100 }
  const original = '这是未处理的旧聊天，有一项工作已经结束。'.repeat(8000)
  env.emitMessage({ text: original, messageId: 20 })
  await waitFor(() => store.blocked(meta))
  env.emitMessage({ text: '本次触发消息', messageId: 21 })
  await waitFor(() => calls === 2 && store.blocked(meta)?.reason.includes('摘要网络中断'))
  const checkpoint = store.readBacklogSummary(meta)
  assert.ok(checkpoint.offset > 0)
  await waitFor(() => env.napcat.calls.filter(call => call.action === 'send_private_msg').length === 2)
  const before = env.napcat.calls.filter(call => call.action === 'send_private_msg').length
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(calls, 2)
  assert.equal(env.napcat.calls.filter(call => call.action === 'send_private_msg').length, before)
  fail = false
  env.emitMessage({ text: '新的触发消息', messageId: 22 })
  await waitFor(() => store.get(meta, '22')?.status === 'processed', { timeout: 15000 })
  assert.equal(store.get(meta, '20').status, 'summarized')
  assert.equal(store.get(meta, '20').body.includes(original), true)
  const agent = [...env.host.agents.values()][0]
  assert.equal(agent.received.length, 1)
  const message = agent.received[0]
  assert.match(textOf(message), /旧积压摘要|新的触发消息/)
  assert.doesNotMatch(textOf(message), /未提供/)
  assert.ok(!message.source.qqMessages.some(item => item.id === '20'))
  assert.ok(message.source.qqMessages.some(item => item.id === '22'))
  await env.reload()
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(store.pending(meta).length, 0)
  assert.equal([...env.host.agents.values()].reduce((count, a) => count + a.received.length, 0), 0)
})

test('摘要期间切换开关取消旧交付，不把新设置阻塞；后续按当前设置处理', async t => {
  let started, release
  const beginning = new Promise(resolve => { started = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  const { env, store } = await environment(t, { config: { backlogSummaryEnabled: true }, llm: {
    prepareCall: async config => ({ config: { maxTokens: 512, ...config }, context: { contextWindow: 18000 } }),
    async *stream() {
      started(); await waiting
      yield { type: 'text-delta', index: 0, text: '摘要' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } })
  env.host.ctx.get('compaction').config = { thresholdRatio: 0.8, headroomTokens: 100 }
  env.emitMessage({ text: '旧聊天'.repeat(15000), messageId: 30 })
  await waitFor(() => store.blocked(meta))
  env.emitMessage({ text: '开始整理旧聊天', messageId: 31 })
  await beginning
  env.config.backlogSummaryEnabled = false
  release()
  await waitFor(() => store.get(meta, '31')?.status === 'processed')
  assert.equal(store.get(meta, '30').status, 'omitted')
  assert.ok(store.readBacklogSummary(meta))
})

test('在途卸载后重载，从成功批次继续，不将旧中断写成永久阻塞', async t => {
  let calls = 0, paused
  const ready = new Promise(resolve => { paused = resolve })
  const payloads = []
  const { env, store } = await environment(t, { config: { backlogSummaryEnabled: true }, llm: {
    prepareCall: async config => ({ config: { maxTokens: 512, ...config }, context: { contextWindow: 18000 } }),
    async *stream(options) {
      payloads.push(JSON.parse(options.messages[0].content[0].text))
      calls++
      if (calls === 2) {
        paused()
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
        options.signal.throwIfAborted()
      }
      yield { type: 'text-delta', index: 0, text: `摘要${calls}` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } })
  env.host.ctx.get('compaction').config = { thresholdRatio: 0.8, headroomTokens: 100 }
  env.emitMessage({ text: '完整旧消息'.repeat(18000), messageId: 40 })
  await waitFor(() => store.blocked(meta))
  env.emitMessage({ text: '本次触发', messageId: 41 })
  await ready
  const checkpoint = store.readBacklogSummary(meta)
  assert.ok(checkpoint.offset > 0)
  await env.reload()
  env.host.ctx.get('compaction').config = { thresholdRatio: 0.8, headroomTokens: 100 }
  await waitFor(() => store.get(meta, '41')?.status === 'processed', { timeout: 15000 })
  assert.equal(payloads[2].previousSummary, checkpoint.text)
  assert.equal(payloads[2].messages[0].from, checkpoint.offset)
  assert.equal(store.get(meta, '40').status, 'summarized')
  assert.equal(store.pending(meta).length, 0)
})
