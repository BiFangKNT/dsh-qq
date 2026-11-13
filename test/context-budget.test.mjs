import test from 'node:test'
import assert from 'node:assert/strict'
import { createContextBudget } from '../src/context-budget.js'
import { createMessageStore } from '../src/message-store.js'
import { createMockPromptScope } from './mock-dsh.mjs'

const meta = { selfId: '90001', scope: 'group', peerId: '70001' }
const text = value => ({ role: 'user', content: [{ type: 'text', text: value }] })
function fixture(t, extra = {}) {
  const store = createMessageStore(), config = { contextTokenizerFamily: 'v41' }
  t.after(() => store.close())
  const llm = {
    async prepareCall(config) { return { config: { maxTokens: 100, ...config }, context: { contextWindow: 6000 } } },
    imageRequestPricing: () => ({ priceImages: images => images.map(() => ({ visualTokens: 400, text: 'image' })) }),
    fileRequestText: file => file.text,
    ...extra.llm,
  }
  let history = [text('旧历史'.repeat(500))], compactCalls = 0, encoded = 0
  const compaction = { config: { thresholdRatio: 0.8, headroomTokens: 100 }, async compactNow() {
    compactCalls++
    assert.ok(!JSON.stringify(history).includes('新增源消息'))
    if (extra.compactError) throw new Error('压缩失败')
    if (extra.noCompact) return null
    history = [text('已有历史的摘要')]
    return { endSeq: 10 }
  } }
  const ctx = { get: key => ({ llm, compaction })[key] }
  const scope = createMockPromptScope(ctx)
  scope.get('systemPrompt').section({ name: 'base', text: 'SYSTEM', order: 0 })
  const record = { ...meta, sessionId: 'main', agent: { ctx: scope,
    model: { current: () => ({ provider: 'test', model: 'model' }) },
    session: { id: 'main', deriveMessages: () => history },
  } }
  const capacity = createContextBudget({ ctx, config, store, ...(extra.realTokenizer ? {} : {
    encode: async (_family, value) => { encoded++; return value.length },
  }) })
  return { store, config, ctx, llm, compaction, record, capacity,
    manager: { runtimeContext: () => '动态状态' },
    get compactCalls() { return compactCalls }, get encoded() { return encoded },
    get history() { return history }, set history(value) { history = value } }
}
const add = (store, n, body) => store.put(meta, { id: String(n), body, message: { text: body }, source: {}, receivedAt: n, decision: 'yes' })
const render = (selected, omitted) => `${omitted.length ? '未提供：' + omitted.length + '\n' : ''}` + selected.map(row => row.body).join('\n')

test('统一计量含 system、工具、图像与文件，计数复用，路由和压缩策略跟随实际模型', async t => {
  const h = fixture(t)
  const options = { provider: 'test', model: 'model', system: 'SYSTEM', tools: [{ name: 'tool' }],
    messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }, { type: 'file', attachment: { text: '文件正文' } }] }] }
  const total = await h.capacity.measure(options), encoded = h.encoded
  assert.equal(await h.capacity.measure(options), total)
  assert.equal(h.encoded, encoded)
  const once = await h.capacity.measure({ ...options, messages: [{ role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] }, ...options.messages] })
  assert.equal(once, total + 16, '已经包含 system 时不重复追加')
  h.compaction.config.modelPolicies = [{ provider: 'test', model: 'model', thresholdRatio: 0.5, headroomTokens: 200 }]
  assert.equal((await h.capacity.inputBudget(options)).limit, 3000)
  delete h.llm.imageRequestPricing
  await assert.rejects(h.capacity.measure(options), /图片 token 计量/)
})

test('先压缩已有历史，再左截断积压，完整保留触发消息，遗漏不冒充已读且不自动重放', async t => {
  const h = fixture(t)
  for (let n = 1; n <= 10; n++) add(h.store, n, `新增源消息${n}:` + 'a'.repeat(700))
  const end = h.store.summary(meta).end
  const plan = await h.capacity.select(h.record, h.manager, h.store, end, render)
  assert.equal(h.compactCalls, 1)
  assert.equal(plan.selected.at(-1).id, '10')
  assert.ok(plan.omitted.length > 0)
  assert.ok(plan.tokens <= plan.limit)
  assert.match(plan.body, /未提供/)
  const id = h.store.begin(meta, 'main', plan.selected, plan.omitted)
  h.store.finish(id, 'processed')
  assert.equal(h.store.pending(meta).length, 0)
  assert.equal(h.store.get(meta, '1').status, 'omitted')
  assert.match(h.store.get(meta, '1').body, /新增源消息1/)
})

test('没有可压缩内容只尝试一次；单条过大或压缩失败均保留原消息', async t => {
  const h = fixture(t, { noCompact: true })
  add(h.store, 1, 'x'.repeat(5000))
  await assert.rejects(h.capacity.select(h.record, h.manager, h.store, 100, render), /触发消息无法完整/)
  assert.equal(h.compactCalls, 1)
  assert.equal(h.store.pending(meta).length, 1)
  const broken = fixture(t, { compactError: true })
  add(broken.store, 1, 'x'.repeat(5000))
  await assert.rejects(broken.capacity.select(broken.record, broken.manager, broken.store, 100, render), /压缩失败/)
  assert.equal(broken.compactCalls, 1)
  assert.equal(broken.store.get(meta, '1').status, 'pending')
})

test('分类器只截输入副本，工具轮不切断，移除对应图片，当前消息始终保留', async t => {
  const h = fixture(t), original = JSON.stringify(h.history)
  const payload = { mainContext: { messages: [
    { ...text('旧对话'.repeat(1000)), qqContextIndex: 0 },
    { role: 'assistant', qqContextIndex: 1, content: [{ type: 'tool-call', name: 'read', id: 'call-1' }] },
    { role: 'tool', qqContextIndex: 2, content: [{ type: 'text', text: '工具结果' }] },
    { ...text('近期对话'), qqContextIndex: 3 },
  ] }, pendingMessages: [{ id: 'pending-1', body: '未处理背景' }], current: { text: '本次消息' },
  imageInputs: [{ source: 'mainContext', contextIndex: 0, imageIndex: 0 },
    { source: 'current', imageIndex: 1 }] }
  const options = { provider: 'test', model: 'model', system: 'classifier', tools: [], messages: [{
    role: 'user', content: [{ type: 'text', text: JSON.stringify(payload) },
      { type: 'image', attachment: { id: 'old-image' } }, { type: 'image', attachment: { id: 'current-image' } }],
  }] }
  const selected = await h.capacity.classifierRequest(options), data = JSON.parse(selected.messages[0].content[0].text)
  assert.equal(data.missingContext, true)
  assert.ok(data.mainContext.messages.every(message => message.qqContextIndex >= 3))
  assert.deepEqual(selected.messages[0].content.slice(1).map(block => block.attachment.id), ['current-image'])
  assert.equal(data.current.text, '本次消息')
  assert.equal(JSON.stringify(h.history), original)
  assert.equal(h.compactCalls, 0)
  assert.equal(payload.mainContext.messages.length, 4, '传入对象不变')
})

test('最终组装检查包含宿主额外输入，工具续调同样拦截；普通 session 不受影响', async t => {
  const h = fixture(t)
  let listener
  h.capacity.install({ on: (_name, fn) => { listener = fn; return () => {} } }, h.record.agent)
  let calls = 0
  const next = async function* () { calls++; yield 'ok' }
  const options = { sessionId: 'main', provider: 'test', model: 'model', system: 's', messages: [text('宿主附加'.repeat(1500))] }
  await assert.rejects(async () => { for await (const _ of listener(options, next)) {} }, /输入容量检查失败/)
  assert.equal(calls, 0)
  for await (const _ of listener({ ...options, sessionId: 'ordinary' }, next)) {}
  assert.equal(calls, 1)
  for await (const _ of listener({ ...options, messages: [text('正常工具结果')] }, next)) {}
  assert.equal(calls, 2)
})

test('压缩请求的最终检查只扣输出上限，仍拦截实际超窗输入', async t => {
  const h = fixture(t, { llm: { async prepareCall(config) {
    return { config: { maxTokens: 8192, ...config }, context: { contextWindow: 131072 } }
  } } })
  h.compaction.config.headroomTokens = 65536
  const options = { sessionId: 'main', purpose: 'compaction', provider: 'test', model: 'model',
    maxTokens: 65536, messages: [text('待压缩的历史')] }
  let listener, calls = 0
  h.capacity.install({ on: (_name, fn) => { listener = fn } }, h.record.agent)
  const next = async function* () { calls++; yield 'summary' }
  for await (const _ of listener(options, next)) {}
  assert.equal(calls, 1)
  assert.equal((await h.capacity.check(options)).hard, 65536)
  await assert.rejects(async () => {
    for await (const _ of listener({ ...options, messages: [text('x'.repeat(65536))] }, next)) {}
  }, /最终请求含辅助输入后超出预算/)
  assert.equal(calls, 1)
})

test('消息预选跟随驱动首轮、后续和借用会话的显式输出控制，旧默认值重新解析', async t => {
  const h = fixture(t, { llm: { async prepareCall(config) {
    return { config: { maxTokens: 65536, ...config }, context: { contextWindow: 131072 } }
  } } })
  h.compaction.config.headroomTokens = 65536
  const { record } = h
  record.owned = true
  record.agent.options = { maxTokens: 8192 }
  let header
  record.agent.session.requestHeader = () => header
  add(h.store, 1, '本次消息')
  const select = () => h.capacity.select(record, h.manager, h.store, 1, render)
  assert.equal((await select()).limit, 57344, '新会话使用 AgentOptions 的显式上限')
  header = { config: { provider: 'test', model: 'model', maxTokens: 65536 } }
  assert.equal((await select()).limit, 57344, '恢复驱动首轮不沿用旧请求头')
  let listener
  h.capacity.install({ on: (_name, fn) => { listener = fn } }, record.agent)
  const next = async function* () {}
  for await (const _ of listener({ sessionId: 'main', purpose: 'compaction', ...header.config, messages: [text('历史')] }, next)) {}
  assert.equal((await select()).limit, 57344, '压缩请求不改变驱动首轮控制')
  header.config.maxTokens = 4096
  for await (const _ of listener({ sessionId: 'main', ...header.config, messages: [text('消息')] }, next)) {}
  assert.equal((await select()).limit, 61440, '主请求之后沿用请求头中的显式上限')
  const before = h.capacity.fingerprint(record)
  header.config.maxTokens = 2048
  assert.notEqual(h.capacity.fingerprint(record), before, '输出控制变化解除原容量阻断')
  assert.equal((await select()).limit, 63488)
  record.agent = { ...record.agent, options: { maxTokens: 32768 } }
  record.owned = false
  assert.equal((await select()).limit, 63488, '借用已运行驱动直接沿用现有控制')
  header.adapterDefaults = { maxTokens: true }
  record.agent.model.current = () => ({ provider: 'test', model: 'switched' })
  h.llm.prepareCall = async config => ({ config: { maxTokens: 16384, ...config }, context: { contextWindow: 131072 } })
  assert.equal((await select()).limit, 49152, '换模型时剥离旧模型的默认输出值')
})

test('官方 tokenizer 后台分词可复用系列，正文中特殊标记不按一个边界 token 少算', async t => {
  const h = fixture(t, { realTokenizer: true })
  assert.ok(await h.capacity.textCount('你好世界') > 0)
  assert.ok(await h.capacity.textCount('<｜begin▁of▁sentence｜>') > 1)
  const first = await h.capacity.textCount('日常消息，按系列缓存。')
  assert.equal(await h.capacity.textCount('日常消息，按系列缓存。'), first)
  h.config.contextTokenizerFamily = 'v4'
  assert.ok(await h.capacity.textCount('日常消息，按系列缓存。') > 0)
  h.config.contextTokenizerFamily = 'unknown'
  await assert.rejects(h.capacity.textCount('text'), /受支持/)
})
