import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemory } from '../src/memory.js'
import { createMemoryStore } from '../src/memory-store.js'
import { buildRuntimeContext } from '../src/runtime-context.js'
import { createMockEnvironment } from './mock-environment.mjs'
import { waitFor } from './mock-dsh.mjs'

const temp = () => mkdtempSync(join(tmpdir(), 'qq-memory-'))
const meta = (root, selfId = '10001') => ({ selfId, scope: 'private', peerId: '11001', label: '私聊 示例(11001)', dir: join(root, '私聊_11001') })
const response = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]

test('事项完成跨 session 保留；旧版本不能覆盖，读取和重启不续期', async () => {
  const root = temp(), record = meta(root)
  let clock = 1000
  const store = createMemoryStore(root, { now: () => clock, taskTtlMs: () => 100 })
  let data = store.migrate(record)
  const entry = store.change(data, { kind: 'task', text: '做头像' })
  data = store.write(record, data, data.revision)
  clock = 1100
  assert.equal(store.effective(store.read(record).entries[0]).status, 'unverified')
  assert.equal(store.read(record).entries[0].verifyAt, 1100)
  store.change(data, { id: entry.id, version: 1, status: 'completed' })
  store.write(record, data, data.revision)
  assert.throws(() => store.change(store.read(record), { id: entry.id, version: 1, status: 'active' }), /版本/)
  const memory = createMemory({ home: root, config: {} })
  assert.match(memory.render({ ...record, sessionId: 'new-session' }), /没有已记录/)
  assert.equal(createMemoryStore(root).read(record).entries[0].status, 'completed')
})

test('迁移备份且只运行一次；旧便签一律待核实，账号隔离', () => {
  const root = temp(), record = meta(root)
  mkdirSync(record.dir, { recursive: true })
  writeFileSync(join(record.dir, '便签.md'), '很久以前说要做的事情')
  const store = createMemoryStore(root)
  const data = store.migrate(record)
  assert.equal(data.entries[0].status, 'unverified')
  writeFileSync(join(record.dir, '便签.md'), '旧文件后来改变，不应重读')
  assert.equal(store.migrate(record).entries.length, 1)
  assert.equal(store.migrate(meta(root, '10002')).entries.length, 0)
  const backups = join(store.fileFor(record), '..', 'legacy')
  assert.equal(readFileSync(join(backups, readdirSync(backups)[0]), 'utf8'), '很久以前说要做的事情')
})

test('坏文件保留，不覆盖为空，不把读取失败当空列表', () => {
  const root = temp(), record = meta(root), store = createMemoryStore(root)
  store.migrate(record)
  writeFileSync(store.fileFor(record), '{broken')
  const memory = createMemory({ home: root, config: {} })
  assert.match(memory.render(record), /读取失败/)
  assert.throws(() => store.migrate(record))
  assert.equal(readFileSync(store.fileFor(record), 'utf8'), '{broken')
})

test('每轮自动维护更新原事项，成功去重；失败保留工作且隐藏未核实事项', async () => {
  const root = temp(), record = { ...meta(root), sessionId: 's1' }
  let calls = 0, fail = false
  const llm = { async *stream(options) {
    calls++
    if (fail) throw new Error('network')
    const input = JSON.parse(options.messages[0].content[0].text)
    const previous = input.entries.find(e => e.kind === 'task')
    const change = previous ? { id: previous.id, version: previous.version, status: 'completed' } : { kind: 'task', text: '做头像' }
    yield* response(JSON.stringify({ changes: [{ ...change, evidence: [input.evidence[0].id] }] }))
  } }
  const memory = createMemory({ home: root, config: { provider: 'mock', model: 'mock' }, getLlm: () => llm })
  const session = { snapshotEvents() { return this.events }, events: [] }
  const turn = (seq, text) => {
    session.events.push({ seq, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
    const end = { seq: seq + 1, type: 'turn/end' }
    session.events.push(end)
    memory.onSessionEvent(record, session, end)
  }
  await memory.prepare(record)
  turn(0, '周六做头像')
  await memory.wait(record)
  assert.match(memory.render(record), /做头像/)
  assert.equal(memory.query(record)[0].status, 'active')
  fail = true
  turn(2, '头像已经做完了')
  await memory.wait(record)
  assert.match(memory.render(record), /尚未核实/)
  assert.doesNotMatch(memory.render(record), /有效当前事项：/)
  fail = false
  await memory.prepare(record)
  assert.equal(memory.query(record)[0].status, 'completed')
  const count = calls
  await memory.prepare(record)
  assert.equal(calls, count)
})

test('真实插件 mock：末尾只保留当前状态，不写聊天或 compact；统一工具更新', async t => {
  const env = await createMockEnvironment({ root: temp() })
  t.after(() => env.close())
  env.emitMessage({ text: '你好' })
  await waitFor(() => [...env.host.agents.values()][0]?.requests.length === 1)
  const agent = [...env.host.agents.values()][0]
  await agent.whenIdle()
  const tool = env.host.tools.get('qq_memory')
  const entry = (await tool.execute({ action: 'add', kind: 'fact', text: '喜欢蓝色' }, { agent })).entries[0]
  env.emitMessage({ text: '再说一句' })
  await waitFor(() => agent.requests.length === 2)
  await agent.whenIdle()
  assert.match(agent.requests[1].messages.at(-1).content[0].text, /喜欢蓝色/)
  assert.doesNotMatch(JSON.stringify(agent.session.deriveMessages()), /喜欢蓝色/)
  await tool.execute({ action: 'update', id: entry.id, version: entry.version, status: 'removed' }, { agent })
  env.emitMessage({ text: '第三句' })
  await waitFor(() => agent.requests.length === 3)
  assert.doesNotMatch(agent.requests[2].context, /喜欢蓝色/)
  assert.equal(env.host.tools.has('qq_pin'), false)
  assert.equal(env.host.tools.has('qq_facts'), false)
  assert.equal(env.host.tools.has('qq_glossary'), false)
})

test('明确未来日期不被默认间隔缩短，无变化不续期；不同聊天独立', () => {
  const root = temp(), record = meta(root)
  let clock = 1000
  const store = createMemoryStore(root, { now: () => clock, taskTtlMs: () => 100 })
  let data = store.migrate(record)
  const task = store.change(data, { kind: 'task', text: '下周做头像', verifyAt: 10000 })
  data = store.write(record, data, data.revision)
  clock = 3000
  store.change(data, { id: task.id, version: 1, text: '下周做两张头像' })
  store.write(record, data, data.revision)
  assert.equal(store.read(record).entries[0].verifyAt, 10000)
  assert.equal(store.read({ ...record, peerId: '11002' }).entries.length, 0)
  assert.throws(() => store.change(store.read(record), { kind: 'task', text: '下周做两张头像' }), /已存在/)
  const normal = store.change(data, { kind: 'task', text: '待办' })
  clock = 3050
  store.change(data, { id: normal.id, version: 1, text: normal.text })
  assert.equal(data.entries.at(-1).verifyAt, 3100)
  clock = 3200
  store.change(data, { id: normal.id, version: 2, status: 'active' })
  assert.equal(data.entries.at(-1).verifyAt, 3300)
  assert.throws(() => store.change(data, { id: normal.id, version: 3, verifyAt: null }), /不能设为永久/)
  const invalid = createMemoryStore(root, { taskTtlMs: () => NaN })
  assert.throws(() => invalid.change(data, { kind: 'task', text: '无效间隔不能生成永久待办' }), /核实时间无效/)
})

test('完成回合未存维护任务时，恢复从日志补收且不重复维护', async () => {
  const root = temp(), record = { ...meta(root), sessionId: 'recovered' }
  let calls = 0
  record.agent = { session: { snapshotEvents() { return this.events }, events: [
    { seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '已完成' }] } },
    { seq: 1, type: 'turn/end' },
  ] } }
  const llm = { async *stream() { calls++; yield* response('{"changes":[]}') } }
  const memory = createMemory({ home: root, config: { provider: 'mock', model: 'mock' }, getLlm: () => llm })
  await memory.prepare(record)
  await memory.prepare(record)
  memory.onSessionEvent(record, record.agent.session, record.agent.session.events[1])
  await memory.wait(record)
  assert.equal(calls, 1)
  assert.equal(memory.status(record), '已整理')
})

test('自动维护不能凭助手复述重新激活已完成事项，保留失败任务', async () => {
  const root = temp(), record = { ...meta(root), sessionId: 's1' }
  const store = createMemoryStore(root)
  const data = store.migrate(record)
  const entry = store.change(data, { kind: 'task', text: '做头像', status: 'completed' })
  store.write(record, data, data.revision)
  const llm = { async *stream(options) {
    const input = JSON.parse(options.messages[0].content[0].text)
    yield* response(JSON.stringify({ changes: [{ id: entry.id, version: 1, status: 'active', evidence: [input.evidence[0].id] }] }))
  } }
  const memory = createMemory({ home: root, config: { provider: 'mock', model: 'mock' }, getLlm: () => llm })
  const session = { snapshotEvents() { return this.events }, events: [{ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '之前答应做头像' }] } } }] }
  memory.onSessionEvent(record, session, { seq: 1, type: 'turn/end' })
  await memory.wait(record)
  assert.equal(memory.query(record)[0].status, 'completed')
  assert.equal(store.read(record).jobs.length, 1)
  assert.match(memory.render(record), /尚未核实/)
})

test('compact 摘要和插件提示不作为新增用户证据，不触发无意义维护', async () => {
  const root = temp(), record = { ...meta(root), sessionId: 'compact' }
  let calls = 0
  const memory = createMemory({ home: root, config: { provider: 'mock', model: 'mock' },
    getLlm: () => ({ async *stream() { calls++; yield* response('{"changes":[]}') } }) })
  const session = { snapshotEvents() { return this.events }, events: [{ seq: 0, type: 'user/message', surfaceOp: 'replace',
    data: { source: { kind: 'plugin', plugin: 'compaction' }, content: [{ type: 'text', text: '旧摘要里说要做头像' }] } }] }
  memory.onSessionEvent(record, session, { seq: 1, type: 'turn/end' })
  await memory.wait(record)
  assert.equal(calls, 0)
  assert.equal(memory.store.read(record).jobs.length, 0)
})

test('群近况只提供给 owner 且只读取显式允许的群；群停用立即生效', () => {
  const root = temp(), record = meta(root)
  const now = new Date(), day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
  for (const id of ['22001', '22002']) {
    mkdirSync(join(root, `群_${id}`, '聊天记录'), { recursive: true })
    writeFileSync(join(root, `群_${id}`, '聊天记录', `${day}.md`), `- 12:00:00 · 群友(11002)：群消息${id}\n`)
  }
  const config = { workspaceRoot: root, groupMode: 'allowlist', ownerIds: ['11001'], groupAllow: ['22001'] }
  const memory = { render: () => 'memory' }
  const render = (r = record) => buildRuntimeContext({ memory, config, record: r })
  assert.match(render(), /群消息22001/)
  assert.doesNotMatch(render(), /群消息22002/)
  assert.doesNotMatch(render({ ...record, peerId: '11003' }), /群消息/)
  config.groupMode = 'disabled'
  assert.doesNotMatch(render(), /群消息/)
})
