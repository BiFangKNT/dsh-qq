import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createMemory } from '../src/memory.js'

const response = value => [{ type: 'text-delta', index: 0, text: JSON.stringify(value) }, { type: 'finish', reason: { kind: 'stop' } }]
async function setup(t, respond, config = {}) {
  const home = await mkdtemp(join(tmpdir(), 'qq-memory-batch-'))
  const record = { selfId: '10001', scope: 'private', peerId: '11001', sessionId: 'main' }
  const requests = [], warnings = [], memories = []
  const capacity = { route: async () => ({ hard: 6000, output: 1000 }),
    measure: async options => JSON.stringify(options.messages).length + 800,
    check: async options => { assert.ok(await capacity.measure(options) <= (await capacity.route(options)).hard) },
  }
  const create = (overrides = {}) => {
    const memory = createMemory({ home, config: { provider: 'mock', model: 'mock', ...config, ...overrides }, capacity,
      logger: { warn: (...args) => warnings.push(args) }, getLlm: () => ({ async *stream(options) {
        const input = JSON.parse(options.messages[0].content[0].text)
        requests.push(input)
        yield* response(await respond(input, requests.length))
      } }),
    })
    memories.push(memory)
    return memory
  }
  t.after(async () => { for (const memory of memories) { memory.stop(); await memory.wait(record) }; await rm(home, { recursive: true, force: true }) })
  return { record, requests, warnings, create, capacity }
}
const evidence = text => ({ id: 'user-1', type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

test('超长证据和大量终态条目分批读取，保存进度后重启续接，后续完成事件不堵塞', async t => {
  let fail = true, lastId
  const h = await setup(t, (input, count) => {
    if (fail && count === 3) throw new Error('network')
    const last = input.entries.find(entry => entry.id === lastId)
    return { changes: last && last.status === 'active' ? [{ id: last.id, version: last.version, status: 'completed', evidence: [input.evidence[0].id] }] : [] }
  })
  const memory = h.create(), data = memory.store.migrate(h.record)
  for (let i = 0; i < 12; i++) memory.store.change(data, { kind: 'task', text: `旧记录${i}` + '甲'.repeat(900), status: 'completed' })
  lastId = memory.store.change(data, { kind: 'task', text: '需要结束的事项' }).id
  const original = evidence('旧消息'.repeat(3500))
  data.jobs.push({ id: 'large-job', observedAt: 1, evidence: [original] },
    { id: 'later-job', observedAt: 2, evidence: [{ ...evidence('已完成，不用再提醒'), id: 'user-2' }] })
  memory.store.write(h.record, data, data.revision)
  await memory.prepare(h.record); await memory.wait(h.record)
  const saved = memory.store.read(h.record)
  assert.ok(saved.jobs[0].progress.scan > 0)
  assert.equal(saved.jobs.length, 2)
  const before = h.requests.length
  fail = false; memory.stop()
  const resumed = h.create()
  await resumed.prepare(h.record); await resumed.wait(h.record)
  assert.equal(resumed.store.read(h.record).jobs.length, 0)
  assert.equal(resumed.query(h.record).find(entry => entry.id === lastId).status, 'completed')
  assert.ok(h.requests.length > before + 1)
  assert.ok(h.requests.every(request => request.entries.every(entry => !Object.hasOwn(entry, 'history'))))
  const fragments = new Map()
  for (const request of h.requests) for (const item of request.evidence) {
    if (item.id === original.id && item.fragment) fragments.set(item.fragment.from, item.fragment)
  }
  const ordered = [...fragments.values()].sort((a, b) => a.from - b.from)
  assert.equal(ordered[0].from, 0)
  for (let i = 1; i < ordered.length; i++) assert.equal(ordered[i].from, ordered[i - 1].to)
  assert.equal(ordered.map(piece => piece.text).join(''), JSON.stringify(original))
})

test('超长单条记忆连续读取，不能用片段覆盖全文', async t => {
  let reject = true
  const h = await setup(t, input => ({ changes: reject ? [{ id: input.entries[0].id, version: input.entries[0].version,
    text: '错误地替换成片段', evidence: [input.evidence[0].id] }] : [] }))
  const memory = h.create(), data = memory.store.migrate(h.record)
  const original = '超长记忆😀'.repeat(3000)
  memory.store.change(data, { kind: 'fact', text: original })
  data.jobs.push({ id: 'job', observedAt: 1, evidence: [evidence('核对')] })
  memory.store.write(h.record, data, data.revision)
  await memory.prepare(h.record); await memory.wait(h.record)
  assert.equal(memory.query(h.record)[0].text, original)
  assert.equal(memory.store.read(h.record).jobs.length, 1)
  reject = false
  await memory.prepare(h.record); await memory.wait(h.record)
  assert.equal(memory.store.read(h.record).jobs.length, 0)
  const pieces = new Map(h.requests.flatMap(input => input.entries).map(entry => [entry.fragment.from, entry]))
  assert.equal([...pieces.values()].sort((a, b) => a.fragment.from - b.fragment.from).map(entry => entry.text).join(''), original)
})

test('维护期间收到新回合不覆盖队列，显式修改在当前一批后即可执行', async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers()
  let memory
  const h = await setup(t, async (_input, count) => { if (count === 1) { entered.resolve(); await gate.promise }; return { changes: [] } })
  memory = h.create()
  const data = memory.store.migrate(h.record)
  for (let i = 0; i < 10; i++) memory.store.change(data, { kind: 'fact', text: `事实${i}` + '字'.repeat(1000) })
  data.jobs.push({ id: 'old-job', observedAt: 1, evidence: [evidence('旧消息')] })
  memory.store.write(h.record, data, data.revision)
  const preparing = memory.prepare(h.record)
  await entered.promise
  const end = { seq: 1, type: 'turn/end' }
  const session = { snapshotEvents: () => [{ seq: 0, type: 'user/message', data: evidence('新消息').data }, end] }
  memory.onSessionEvent(h.record, session, end)
  const updated = memory.update(h.record, { kind: 'task', text: '手动新增事项' })
  gate.resolve()
  await updated
  assert.ok(h.requests.length < 4)
  await preparing; await memory.wait(h.record)
  assert.ok(h.requests.some(input => JSON.stringify(input.evidence).includes('新消息')))
  assert.equal(memory.store.read(h.record).jobs.length, 0)
})

test('新增先保留候选，后续页发现已有条目时更正原条目而不重复新增', async t => {
  let target
  const h = await setup(t, input => {
    const existing = input.entries.find(entry => entry.id === target)
    if (existing) return { changes: [{ id: target, version: existing.version, status: 'completed', evidence: [input.evidence[0].id] }],
      discardNew: input.proposed.map((_, index) => index) }
    return { changes: input.firstPage ? [{ kind: 'task', text: '不要重复创建', evidence: [input.evidence[0].id] }] : [] }
  })
  const memory = h.create(), data = memory.store.migrate(h.record)
  for (let i = 0; i < 8; i++) memory.store.change(data, { kind: 'fact', text: `旧事实${i}` + '字'.repeat(900) })
  target = memory.store.change(data, { kind: 'task', text: '已有事项' }).id
  data.jobs.push({ id: 'job', observedAt: 1, evidence: [evidence('这件事已完成')] })
  memory.store.write(h.record, data, data.revision)
  await memory.prepare(h.record); await memory.wait(h.record)
  assert.ok(h.requests.some(input => !input.firstPage && input.proposed.length === 1))
  assert.equal(memory.query(h.record).find(entry => entry.id === target).status, 'completed')
  assert.equal(memory.query(h.record).length, 9)
  assert.equal(memory.store.read(h.record).jobs.length, 0)
})

for (const change of ['model', 'capacity']) {
  test(`分页中断后更换 ${change}，重规划首页不携带旧候选且能完成原任务`, async t => {
    let target, fail = true, limit = 6000
    const h = await setup(t, (input, count) => {
      if (fail && count === 2) throw new Error('network')
      const existing = input.entries.find(entry => entry.id === target)
      if (existing) return { changes: [{ id: target, version: existing.version, status: 'completed', evidence: [input.evidence[0].id] }],
        discardNew: input.proposed.map((_, index) => index) }
      return { changes: input.firstPage ? [{ kind: 'task', text: '旧候选', evidence: [input.evidence[0].id] }] : [] }
    })
    h.capacity.route = async options => ({ hard: options.model === 'larger' ? 18000 : limit, output: 1000 })
    const memory = h.create(), data = memory.store.migrate(h.record)
    for (let i = 0; i < 8; i++) memory.store.change(data, { kind: 'fact', text: `旧事实${i}` + '字'.repeat(900) })
    target = memory.store.change(data, { kind: 'task', text: '原有事项' }).id
    data.jobs.push({ id: 'job', observedAt: 1, evidence: [evidence('原有事项已经完成')] })
    memory.store.write(h.record, data, data.revision)
    await memory.prepare(h.record); await memory.wait(h.record)
    const saved = memory.store.read(h.record)
    assert.equal(saved.jobs.length, 1)
    assert.equal(saved.jobs[0].progress.proposed.length, 1)
    assert.ok(saved.jobs[0].progress.scan > 0)
    memory.stop()
    fail = false
    if (change === 'capacity') limit = 18000
    const before = h.requests.length, warnings = h.warnings.length
    const resumed = h.create(change === 'model' ? { model: 'larger' } : {})
    await resumed.prepare(h.record); await resumed.wait(h.record)
    assert.equal(resumed.store.read(h.record).jobs.length, 0)
    assert.equal(resumed.query(h.record).find(entry => entry.id === target).status, 'completed')
    assert.equal(resumed.query(h.record).length, 9)
    assert.equal(h.requests[before].firstPage, true)
    assert.deepEqual(h.requests[before].proposed, [])
    assert.equal(h.warnings.length, warnings)
  })
}

test('模型忽略 signal 时超时仍释放维护等待，不写迟到结果或丢失任务', async t => {
  const gate = Promise.withResolvers()
  const h = await setup(t, () => gate.promise, { memoryTimeoutMs: 25 })
  const memory = h.create(), data = memory.store.migrate(h.record)
  data.jobs.push({ id: 'job', observedAt: 1, evidence: [evidence('需要记住的事情')] })
  memory.store.write(h.record, data, data.revision)
  await memory.prepare(h.record)
  assert.equal(memory.store.read(h.record).jobs.length, 1)
  assert.ok(h.warnings.some(values => JSON.stringify(values).includes('超时')))
  gate.resolve({ changes: [{ kind: 'fact', text: '迟到结果', evidence: ['user-1'] }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(memory.query(h.record).length, 0)
  assert.equal(memory.store.read(h.record).jobs.length, 1)
})

test('恢复时来源改变不复用旧进度，不把剩余依据标为已处理', async t => {
  let fail = true
  const h = await setup(t, (_input, count) => {
    if (fail && count === 2) throw new Error('network')
    return { changes: [] }
  })
  const memory = h.create(), data = memory.store.migrate(h.record)
  for (let i = 0; i < 8; i++) memory.store.change(data, { kind: 'fact', text: `旧事实${i}` + '字'.repeat(900) })
  data.jobs.push({ id: 'job', observedAt: 1, evidence: [evidence('完整依据')] })
  memory.store.write(h.record, data, data.revision)
  await memory.prepare(h.record); await memory.wait(h.record)
  const saved = memory.store.read(h.record)
  assert.ok(saved.jobs[0].progress)
  saved.jobs[0].evidence[0].data.content[0].text = '被修改的依据'
  memory.store.write(h.record, saved, saved.revision)
  const calls = h.requests.length
  fail = false
  await memory.prepare(h.record); await memory.wait(h.record)
  assert.equal(h.requests.length, calls)
  assert.equal(memory.store.read(h.record).jobs.length, 1)
  assert.ok(h.warnings.some(value => JSON.stringify(value).includes('来源或进度无效')))
})

test('分批间隙显式取消受保护，排队旧依据不能在后续页重新激活', async t => {
  let target, fail = true
  const h = await setup(t, (input, count) => {
    if (fail && count === 2) throw new Error('network')
    const previous = input.entries.find(entry => entry.id === target)
    return { changes: previous ? [{ id: target, version: previous.version, status: 'active', evidence: [input.evidence[0].id] }] : [] }
  })
  const memory = h.create(), data = memory.store.migrate(h.record)
  for (let i = 0; i < 6; i++) memory.store.change(data, { kind: 'fact', text: `旧事实${i}` + '字'.repeat(900) })
  target = memory.store.change(data, { kind: 'task', text: '稍后需要取消' }).id
  data.jobs.push({ id: 'job', observedAt: 1, evidence: [evidence('旧依据仍说要做')] })
  memory.store.write(h.record, data, data.revision)
  await memory.prepare(h.record); await memory.wait(h.record)
  await memory.update(h.record, { id: target, version: 1, status: 'cancelled' })
  fail = false
  await memory.prepare(h.record); await memory.wait(h.record)
  assert.equal(memory.query(h.record).find(entry => entry.id === target).status, 'cancelled')
  assert.ok(h.requests.some(input => input.entries.some(entry => entry.id === target && entry.protected)))
  assert.equal(memory.store.read(h.record).jobs.length, 0)
})
