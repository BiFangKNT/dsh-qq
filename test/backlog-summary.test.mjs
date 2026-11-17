import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContextBudget } from '../src/context-budget.js'
import { createMessageStore } from '../src/message-store.js'
import { createMockPromptScope } from './mock-dsh.mjs'

const meta = { selfId: '90001', scope: 'group', peerId: '70001' }
const frames = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const render = (rows, omitted, summary) => [
  ...(summary ? [`旧积压摘要 ${summary.firstSeq}-${summary.lastSeq}: ${summary.text}`] : []),
  ...(omitted.length ? [`未提供 ${omitted.join(',')}`] : []), ...rows.map(row => row.body),
].join('\n')
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qq-backlog-'))
  const store = createMessageStore(root), calls = [], config = {
    contextTokenizerFamily: 'v41', backlogSummaryEnabled: true, backlogSummaryTimeoutMs: 1000,
  }
  let compactCalls = 0, history = []
  const llm = {
    async prepareCall(options) { return { config: { maxTokens: 200, ...options }, context: { contextWindow: 6000 } } },
    async *stream(options) {
      calls.push(options)
      if (extra.stream) yield* extra.stream(options, calls.length)
      else yield* frames(`合并摘要${calls.length}`)
    },
  }
  const ctx = { get: key => ({ llm, compaction: { config: { thresholdRatio: 0.8, headroomTokens: 100 },
    async compactNow() { compactCalls++; assert.ok(!JSON.stringify(history).includes('本次触发')); history = []; return {} },
  } })[key] }
  const scope = createMockPromptScope(ctx)
  scope.get('systemPrompt').section({ name: 'base', text: 'SYSTEM', order: 0 })
  const record = { ...meta, sessionId: 'main', agent: { ctx: scope,
    model: { current: () => ({ provider: 'test', model: 'model', reasoningEffort: 'low' }) },
    session: { id: 'main', deriveMessages: () => history },
  } }
  const capacity = createContextBudget({ ctx, config, store, encode: async (_family, value) => value.length })
  const manager = { runtimeContext: () => 'STATE' }
  const add = (id, body, target = meta) => {
    store.put(target, { id: String(id), body, receivedAt: id, source: {}, message: { text: body }, decision: 'yes' })
    return store.get(target, String(id))
  }
  const select = (options) => capacity.select(record, manager, store, store.summary(meta).end, render, options)
  t.after(async () => { capacity.stop(); store.close(); await rm(root, { recursive: true, force: true }) })
  return { root, store, calls, llm, config, record, capacity, manager, add, select,
    get compactCalls() { return compactCalls }, set history(value) { history = value } }
}

test('默认关闭和全部可放下不调用摘要；先 compact 已有历史，分批与最终请求均有预算', async t => {
  const h = await fixture(t)
  h.add(1, '短消息')
  assert.equal((await h.select()).summary, undefined)
  assert.equal(h.calls.length, 0)
  for (let n = 2; n <= 18; n++) h.add(n, `旧消息${n}:` + 'a'.repeat(900))
  h.add(19, '本次触发，保留原文')
  h.config.backlogSummaryEnabled = false
  const truncated = await h.select()
  assert.ok(truncated.omitted.length > 0)
  assert.equal(h.calls.length, 0)
  h.config.backlogSummaryEnabled = true
  h.history = [{ role: 'user', content: [{ type: 'text', text: '已有历史'.repeat(1200) }] }]
  const plan = await h.select()
  assert.equal(h.compactCalls, 1)
  assert.ok(h.calls.length > 1)
  assert.equal(plan.selected.at(-1).body, '本次触发，保留原文')
  assert.deepEqual(plan.omitted, [])
  assert.ok(plan.tokens <= plan.limit)
  const pieces = h.calls.flatMap(call => JSON.parse(call.messages[0].content[0].text).messages)
  assert.deepEqual(pieces.map(piece => piece.seq), plan.summary.sequences)
  assert.ok(plan.summary.sequences.every(seq => seq < plan.selected[0].seq))
  assert.equal(new Set([...plan.summary.sequences, ...plan.selected.map(row => row.seq)]).size, 19)
  for (const call of h.calls) {
    assert.deepEqual(call.tools, [])
    assert.equal(call.purpose, 'qq-backlog-summary')
    assert.equal(call.provider, 'test')
    assert.equal(call.reasoningEffort, 'low')
    assert.notEqual(call.sessionId, h.record.sessionId)
    assert.ok(await h.capacity.measure(call) <= (await h.capacity.inputBudget(call)).limit)
    assert.doesNotMatch(JSON.stringify(call.messages), /本次触发|SYSTEM|STATE/)
  }
  const delivery = h.store.begin(meta, 'main', plan.selected, [], plan.summary)
  h.store.finish(delivery, 'processed')
  assert.equal(h.store.pending(meta).length, 0)
  assert.equal(h.store.get(meta, '1').status, 'summarized')
  assert.equal(h.store.get(meta, '19').status, 'processed')
  assert.equal(JSON.parse(h.store.delivery(delivery).detail).summary.text, plan.summary.text)
  assert.equal(h.store.query(meta, { seq: 1 })[0].body, '短消息')
})

test('巨型旧消息按连续片段完整摘要，当前巨型触发消息不截断、不摘要', async t => {
  const h = await fixture(t)
  const original = '大段原文😀'.repeat(2400)
  const old = h.add(1, original)
  await assert.rejects(h.select(), /触发消息无法完整/)
  assert.equal(h.calls.length, 0)
  h.add(2, '本次触发')
  const plan = await h.select()
  const pieces = h.calls.flatMap(call => JSON.parse(call.messages[0].content[0].text).messages)
  assert.ok(pieces.length > 2)
  assert.equal(pieces.map(piece => piece.text).join(''), original)
  let offset = 0
  for (const piece of pieces) {
    assert.equal(piece.seq, old.seq)
    assert.equal(piece.from, offset)
    offset = piece.to
    assert.ok(!/[\uD800-\uDBFF]$/.test(piece.text))
  }
  assert.deepEqual(plan.summary.sequences, [old.seq])
  assert.equal(h.store.get(meta, '1').body, original)
})

test('失败不退回截断；重启并新增消息、切换主 session 后复用已成功批次', async t => {
  const h = await fixture(t, { async *stream(_options, number) {
    if (number === 2) throw new Error('模拟网络中断')
    yield* frames(`摘要${number}`)
  } })
  for (let n = 1; n <= 14; n++) h.add(n, `来源${n}:` + 'b'.repeat(1000))
  h.add(15, '本次触发')
  await assert.rejects(h.select(), /模拟网络中断/)
  const checkpoint = h.store.readBacklogSummary(meta)
  assert.ok(checkpoint.after > 0)
  assert.equal(h.store.pending(meta).length, 15)
  const reopened = createMessageStore(h.root)
  const resumed = createContextBudget({ ctx: { get: key => key === 'llm' ? h.llm : {
    config: { thresholdRatio: 0.8, headroomTokens: 100 },
  } }, config: h.config, store: reopened, encode: async (_family, value) => value.length })
  t.after(() => resumed.stop())
  h.add(16, '重启后的新触发')
  h.record.sessionId = 'new-main'
  const plan = await resumed.select(h.record, h.manager, reopened, h.store.summary(meta).end, render)
  const third = JSON.parse(h.calls[2].messages[0].content[0].text)
  assert.equal(third.previousSummary, checkpoint.text)
  assert.ok(third.messages.every(piece => piece.seq > checkpoint.after))
  assert.equal(plan.selected.at(-1).id, '16')
  reopened.close()
})

test('分片中断恢复从持久化 offset 继续，改动已摘要原文使进度失效；账号隔离', async t => {
  const h = await fixture(t, { async *stream(_options, n) {
    if (n === 2) throw new Error('中断')
    yield* frames('摘要')
  } })
  h.add(1, '旧长文'.repeat(5000)); h.add(2, '本次触发')
  await assert.rejects(h.select(), /中断/)
  const checkpoint = h.store.readBacklogSummary(meta)
  assert.ok(checkpoint.offset > 0)
  await h.select()
  const next = JSON.parse(h.calls[2].messages[0].content[0].text)
  assert.equal(next.messages[0].from, checkpoint.offset)
  const before = h.calls.length
  h.add(1, '改写旧长文'.repeat(3500))
  await h.select()
  const rebuilt = JSON.parse(h.calls[before].messages[0].content[0].text)
  assert.equal(rebuilt.previousSummary, '')
  assert.equal(rebuilt.messages[0].from, 0)
  assert.equal(h.store.readBacklogSummary({ ...meta, selfId: '90002' }), null)
})

test('超时、非正常结束、空输出、超长输出和工具调用均保留原文', async t => {
  for (const kind of ['timeout', 'finish', 'empty', 'large', 'tool']) {
    await t.test(kind, async t => {
      const h = await fixture(t, { async *stream() {
        if (kind === 'timeout') { await new Promise(resolve => setTimeout(resolve, 60)); yield* frames('过期摘要'); return }
        if (kind === 'finish') { yield { type: 'finish', reason: { kind: 'length' } }; return }
        if (kind === 'tool') {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c', name: 'send', arguments: '{}' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield* frames(kind === 'empty' ? '' : 'x'.repeat(500))
      } })
      if (kind === 'timeout') h.config.backlogSummaryTimeoutMs = 10
      h.add(1, '旧消息'.repeat(5000)); h.add(2, '本次触发')
      await assert.rejects(h.select(), /摘要/)
      await new Promise(resolve => setTimeout(resolve, 65))
      assert.equal(h.store.pending(meta).length, 2)
      assert.equal(h.store.readBacklogSummary(meta), null)
    })
  }
})

test('卸载取消在途请求；权限、会话或设置变化不继续交付，成功摘要仍保留', async t => {
  for (const kind of ['stop', 'permission', 'config']) {
    await t.test(kind, async t => {
      let allowed = true, h
      h = await fixture(t, { async *stream(options) {
        if (kind === 'stop') h.capacity.stop()
        else if (kind === 'config') h.config.backlogSummaryEnabled = false
        else allowed = false
        if (kind === 'stop') assert.ok(options.signal.aborted)
        yield* frames('摘要')
      } })
      h.add(1, '旧消息'.repeat(5000)); h.add(2, '本次触发')
      await assert.rejects(h.select({ validate: () => {
        if (!allowed) throw Object.assign(new Error('权限撤销'), { code: 'QQ_DELIVERY_CHANGED' })
      } }))
      assert.equal(h.store.pending(meta).length, 2)
      assert.equal(h.calls.length, 1)
      assert.equal(Boolean(h.store.readBacklogSummary(meta)), kind !== 'stop')
    })
  }
})

test('摘要投递接纳证据恢复，不重复交付；附件及原文保留可查', async t => {
  const h = await fixture(t)
  const old = h.add(1, '旧消息'.repeat(5000)); h.add(2, '本次触发')
  h.store.put(meta, { ...old, attachmentPaths: ['attachment.png'] })
  const plan = await h.select()
  const id = h.store.begin(meta, 'main', plan.selected, [], plan.summary)
  h.record.agent.session.snapshotEvents = () => []
  h.store.recover(h.record)
  assert.equal(h.store.get(meta, '1').status, 'pending')
  assert.equal(h.store.get(meta, '2').status, 'pending')
  const next = h.store.begin(meta, 'main', plan.selected, [], plan.summary)
  h.record.agent.session.snapshotEvents = () => [{ type: 'user/message', seq: 1,
    data: { message: { source: { qqDeliveryId: next } } } }]
  h.store.recover(h.record)
  assert.equal(h.store.get(meta, '1').status, 'summarized')
  assert.equal(h.store.get(meta, '2').status, 'failed')
  assert.equal(h.store.pending(meta).length, 0)
  assert.ok(h.store.protectedPaths().has('attachment.png'))
  assert.equal(JSON.parse(h.store.delivery(id).detail).reason, 'not_admitted')
})
