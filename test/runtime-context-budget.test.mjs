import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemory } from '../src/memory.js'
import { buildRuntimeContext } from '../src/runtime-context.js'
import { createContextBudget } from '../src/context-budget.js'
import { createMessageStore } from '../src/message-store.js'
import { SILENT_HINT } from '../src/prompts.js'

test('状态区按真实 tokenizer 限量，完整条目稳定选择，遗漏仍可查询且不写回存储', async t => {
  const home = await mkdtemp(join(tmpdir(), 'qq-state-budget-'))
  const messages = createMessageStore()
  t.after(async () => { messages.close(); await rm(home, { recursive: true, force: true }) })
  const config = { provider: 'mock', model: 'mock', stickerEnabled: false, memberLabels: { '11001': '朋友' } }
  const capacity = createContextBudget({ config, store: messages, ctx: { get: key => key === 'llm' ? {
    prepareCall: async () => ({ config: { maxTokens: 1000 }, context: { contextWindow: 24000 } }),
  } : undefined } })
  const memory = createMemory({ home, config })
  const record = { selfId: '10001', scope: 'private', peerId: '11001' }
  const data = memory.store.migrate(record)
  memory.store.change(data, { kind: 'task', text: '当前要讨论的事项' })
  memory.store.change(data, { kind: 'task', text: '已经结束，不应提供', status: 'completed' })
  for (let i = 0; i < 70; i++) memory.store.change(data, { kind: 'fact', text: `记录${i}：` + '完整资料😀'.repeat(70) })
  memory.store.write(record, data, data.revision)
  const before = JSON.stringify(memory.store.read(record))
  const text = await buildRuntimeContext({ memory, config, record, capacity })
  assert.equal(text, await buildRuntimeContext({ memory, config, record, capacity }))
  assert.ok(await capacity.textCount(`${text}\n\n${SILENT_HINT}`) <= Math.floor(23000 / 8))
  assert.match(text, /当前要讨论的事项/)
  assert.doesNotMatch(text, /已经结束/)
  assert.match(text, /未提供 \d+ 条，可用 qq_memory 查询/)
  assert.match(text, /【本轮条件】/)
  assert.equal(memory.query(record, { kind: 'fact' }).length, 70)
  assert.equal(JSON.stringify(memory.store.read(record)), before)
  data.revision = memory.store.read(record).revision
  data.jobs.push({ id: 'pending', observedAt: 1, evidence: [{ id: 'new', type: 'user/message' }] })
  memory.store.write(record, data, data.revision)
  const pending = await buildRuntimeContext({ memory, config, record, capacity })
  assert.match(pending, /当前事项尚未核实/)
  assert.doesNotMatch(pending, /当前要讨论的事项|当前没有已记录/)
})

test('超长账号称呼、收藏规则不撑爆输入，不截成其他称呼或部分规则', async () => {
  const config = { provider: 'mock', model: 'mock', stickerEnabled: false,
    memberLabels: { '11001': '不应截断的称呼'.repeat(1000) }, faceCollectHint: '复杂规则'.repeat(1000) }
  const capacity = { route: async () => ({ hard: 24000 }), textCount: async text => text.length }
  const result = await buildRuntimeContext({ config, record: { scope: 'private', peerId: '11001' }, capacity,
    memory: { contextEntries: () => ({ pending: false, entries: [] }) } })
  assert.ok(result.length + SILENT_HINT.length + 2 <= 3000)
  assert.match(result, /未提供 1 条账号与称呼/)
  assert.match(result, /规则过长未提供，不自动收藏/)
  assert.doesNotMatch(result, /不应截断的称呼|复杂规则/)
})

test('记忆维护使用真实 tokenizer 计入 system 和 JSON，每批发送前重新检查', async t => {
  const home = await mkdtemp(join(tmpdir(), 'qq-maintenance-tokens-')), messages = createMessageStore()
  const config = { provider: 'mock', model: 'mock' }, requests = []
  const llm = { prepareCall: async options => ({ config: { maxTokens: options.maxTokens ?? 1000 }, context: { contextWindow: 8000 } }),
    async *stream(options) {
      requests.push(options)
      yield { type: 'text-delta', index: 0, text: '{"changes":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const capacity = createContextBudget({ config, store: messages, ctx: { get: () => llm } })
  const memory = createMemory({ home, config, capacity, getLlm: () => llm })
  const record = { selfId: '10001', scope: 'private', peerId: '11001', sessionId: 'main' }
  t.after(async () => { memory.stop(); await memory.wait(record); messages.close(); await rm(home, { recursive: true, force: true }) })
  const data = memory.store.migrate(record)
  data.jobs.push({ id: 'large', observedAt: 1, evidence: [{ id: 'new', type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '需要按原顺序核对的聊天😀'.repeat(1200) }] } }] })
  memory.store.write(record, data, data.revision)
  await memory.prepare(record); await memory.wait(record)
  assert.equal(memory.store.read(record).jobs.length, 0)
  assert.ok(requests.length > 1)
  for (const request of requests) assert.ok((await capacity.check(request)).total <= 8000 - request.maxTokens)
})
