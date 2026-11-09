import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createSystemPromptStore, installChatSystem } from '../src/system-prompt.js'
import { SessionManager } from '../src/session.js'
import { deriveSessionId, sessionKey } from '../src/shared/session-id.js'
import { createPromptSync } from '../src/prompt-sync.js'
import { createMockDsh, createMockPromptScope, waitFor } from './mock-dsh.mjs'
import { createMockEnvironment } from './mock-environment.mjs'
import { Config } from '../src/index.js'
import { createInbound } from '../src/inbound.js'

const logger = { info() {}, warn() {}, debug() {} }
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'qq-system-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const meta = { selfId: '10001', scope: 'private', peerId: '11001', label: '测试私聊' }
function fixture({ config = { persona: '初始人设 {{literal_text}}', ownerIds: [] }, store = createSystemPromptStore(''), events = [], header, id = 'fixture', peer = meta } = {}) {
  const ctx = createMockPromptScope({ get() {} })
  const agent = { id, ctx, session: { id, events, requestHeader: () => header } }
  const dispose = installChatSystem({ agentCtx: ctx, config, meta: peer, store })
  const request = async () => {
    const assembly = await ctx.get('systemPrompt').assemble(assembleContextFor(agent))
    const system = renderPrompt(assembly)
    header = { system }
    events.push({ type: 'request/header', seq: events.length, data: { header } })
    return { system, context: renderContextSnapshot(assembly), assembly }
  }
  const compact = data => events.push({ type: 'compaction/end', seq: events.length, data: data ?? {} })
  return { agent, request, compact, config, store, dispose, events }
}

test('每次请求锁定完整 system，工具续调和动态资料变化不改变前缀', async () => {
  const h = fixture()
  let hostVariable = '宿主初值'
  h.agent.ctx.get('systemPrompt').variable('host_value', () => hostVariable)
  h.agent.ctx.get('systemPrompt').section({ name: 'host', order: 20, text: '{{host_value}}' })
  let dynamic = '当前状态一'
  h.agent.ctx.get('systemPrompt').variable('current_value', () => dynamic)
  h.agent.ctx.get('systemPrompt').context({ name: 'current', order: 200, text: '{{current_value}}' })
  const first = await h.request()
  assert.match(first.system, /初始人设 \{\{literal_text\}\}/)
  h.config.persona = '新的人设'
  hostVariable = '宿主改值'
  dynamic = '当前状态二'
  const second = await h.request()
  assert.equal(second.system, first.system)
  assert.match(second.context, /当前状态二/)
  assert.doesNotMatch(second.system, /当前状态|新的人设|宿主改值/)
  assert.equal((await h.request()).system, first.system)
  h.dispose()
})

test('成功压缩后同轮下一请求同步；失败的结束事件不能解锁', async () => {
  const h = fixture()
  const first = await h.request()
  h.config.persona = '压缩后的新设定'
  h.compact({ error: 'summary failed' })
  assert.equal((await h.request()).system, first.system)
  h.compact()
  const updated = await h.request()
  assert.match(updated.system, /压缩后的新设定/)
  assert.doesNotMatch(updated.system, /初始人设/)
  h.config.persona = '再次修改但没有压缩'
  assert.equal((await h.request()).system, updated.system)
  h.dispose()
})

test('重启和闲置恢复沿用磁盘快照，尚未请求也锁定创建时的配置', async t => {
  const root = await directory(t)
  const first = fixture({ store: createSystemPromptStore(root) })
  first.config.persona = '创建后才改的配置'
  const original = await first.request()
  assert.match(original.system, /初始人设/)
  first.dispose()
  const resumed = fixture({ config: { persona: '重启后新配置' }, events: first.events,
    store: createSystemPromptStore(root) })
  assert.equal((await resumed.request()).system, original.system)
  resumed.compact()
  assert.match((await resumed.request()).system, /重启后新配置/)
  resumed.dispose()
})

test('旧版本会话先沿用原请求头，成功压缩才迁移固定规则', async () => {
  const h = fixture({ header: { system: '旧版本完整 system' },
    events: [{ type: 'request/header', seq: 0 }] })
  assert.equal((await h.request()).system, '旧版本完整 system')
  h.compact()
  assert.match((await h.request()).system, /初始人设/)
  h.dispose()
})

test('压缩完成后尚未来得及请求就重启，也会同步最新配置', async () => {
  const h = fixture({ config: { persona: '最新设定' }, header: { system: '旧版本 system' },
    events: [{ type: 'request/header', seq: 0 }, { type: 'compaction/end', seq: 1, data: {} }] })
  assert.match((await h.request()).system, /最新设定/)
  h.dispose()
})

test('群词典按当前会话动态读取；私聊摘要按本地日期读取，资料不进入 system', async t => {
  const root = await directory(t), groupDir = join(root, '群_22001')
  await mkdir(join(groupDir, '记忆区'), { recursive: true })
  await mkdir(join(groupDir, '聊天记录'), { recursive: true })
  const glossary = join(groupDir, '记忆区', '群词典.md')
  await writeFile(glossary, '本群专属词条')
  const now = new Date()
  const day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
  await writeFile(join(groupDir, '聊天记录', `${day}.md`), '- 12:00:00 · 群友(11001)：今天的群聊尾巴\n')
  const config = { persona: '相同角色', workspaceRoot: root }
  const group = fixture({ config, peer: { ...meta, scope: 'group', peerId: '22001', dir: groupDir } })
  const original = await group.request()
  assert.match(original.context, /本群专属词条/)
  assert.doesNotMatch(original.context, /今天群里发生过/)
  await writeFile(glossary, '词条更新后立即可见')
  const updated = await group.request()
  assert.match(updated.context, /词条更新后立即可见/)
  assert.equal(updated.system, original.system)
  const privateChat = fixture({ config, peer: { ...meta, dir: join(root, '私聊_11001') } })
  const other = await privateChat.request()
  assert.doesNotMatch(other.context, /本群专属词条|词条更新后/)
  assert.match(other.context, /今天的群聊尾巴/)
  assert.doesNotMatch(other.system, /词条|今天的群聊尾巴/)
  group.dispose(); privateChat.dispose()
})

async function runtime(t, { borrowed = false } = {}) {
  const root = await directory(t), home = join(root, 'dsh-qq')
  const host = createMockDsh({ home: root })
  const config = Config({ persona: '旧人设', isolateByPeer: false, cwd: root })
  if (borrowed) await host.ctx.agents.create({ sessionId: deriveSessionId(sessionKey(meta.selfId, meta.scope, meta.peerId)) })
  const manager = new SessionManager({ ctx: host.ctx, agents: host.ctx.agents, selfId: '10001', config, logger, home })
  const sync = createPromptSync({ ctx: host.ctx, home, config, manager, logger })
  sync.start()
  t.after(async () => { sync.stop(); manager.stop(); await host.dispose() })
  const record = await manager.obtain(meta)
  return { root, home, host, config, manager, sync, record }
}
const operationOf = (sync, id) => sync.status().operations.find(item => item.id === id)

test('保存相同规则、修改限流不提示；仅相关会话待同步，重新读取仍可见', async t => {
  const h = await runtime(t)
  h.config.rateLimitPerMin = 3
  assert.deepEqual(h.sync.status().pending, [])
  const group = await h.manager.obtain({ ...meta, scope: 'group', peerId: '22001', label: '测试群' })
  h.config.groupPrompt = '群专用新规则'
  const expected = [group.sessionId]
  assert.deepEqual(h.sync.status().pending.map(item => item.sessionId), expected)
  const ui = createPromptSync({ ctx: h.host.ctx, home: h.home, config: h.config, logger })
  assert.deepEqual(ui.status().pending.map(item => item.sessionId), expected)
  h.config.groupPrompt = ''
  assert.deepEqual(h.sync.status().pending, [])
})

test('设置页与运行进程分离时，新建操作读取最新配置，等待回复结束再切换', async t => {
  const h = await runtime(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  h.record.agent.whenIdle = () => gate
  const oldId = h.record.sessionId
  const uiConfig = { ...h.config, persona: '设置页刚保存的人设' }
  await writeFile(join(h.home, 'settings.json'), JSON.stringify({ persona: uiConfig.persona }))
  const ui = createPromptSync({ ctx: h.host.ctx, home: h.home, config: uiConfig, logger })
  const op = ui.request('new', [oldId])
  await waitFor(() => operationOf(ui, op.id)?.status === 'running')
  assert.equal(h.record.sessionId, oldId)
  assert.match(h.manager.systemPrompts.get(oldId).text, /旧人设/)
  release()
  await waitFor(() => operationOf(ui, op.id)?.status === 'done')
  assert.notEqual(h.record.sessionId, oldId)
  assert.match(h.manager.systemPrompts.get(h.record.sessionId).text, /设置页刚保存的人设/)
  assert.equal(h.manager.systemPrompts.get(oldId).retired, true)
  assert.deepEqual(h.sync.status().pending, [])
  assert.equal(h.manager.find(h.record.sessionId), h.record)
})

test('压缩成功保存摘要和新 system，失败或无可压缩内容保留旧快照并报告原因', async t => {
  const h = await runtime(t)
  const original = h.manager.systemPrompts.get(h.record.sessionId).text
  h.config.persona = '待同步人设'
  let op = h.sync.request('compact', [h.record.sessionId])
  await waitFor(() => operationOf(h.sync, op.id)?.status === 'failed')
  assert.match(operationOf(h.sync, op.id).sessions[0].error, /没有可压缩/)
  assert.equal(h.manager.systemPrompts.get(h.record.sessionId).text, original)
  const compaction = h.host.ctx.get('compaction'), compactNow = compaction.compactNow
  compaction.compactNow = async () => { throw new Error('摘要服务失败') }
  op = h.sync.request('compact', [h.record.sessionId])
  await waitFor(() => operationOf(h.sync, op.id)?.status === 'failed')
  assert.match(operationOf(h.sync, op.id).sessions[0].error, /摘要服务失败/)
  assert.equal(h.manager.systemPrompts.get(h.record.sessionId).text, original)
  compaction.compactNow = compactNow
  h.record.agent.followup({ content: [{ type: 'text', text: '需要保留的聊天' }] })
  await h.record.agent.whenIdle()
  op = h.sync.request('compact', [h.record.sessionId])
  await waitFor(() => operationOf(h.sync, op.id)?.status === 'done')
  assert.match(h.manager.systemPrompts.get(h.record.sessionId).text, /待同步人设/)
  assert.match(JSON.stringify(h.record.agent.session.deriveMessages()), /模拟压缩摘要/)
  assert.deepEqual(h.sync.status().pending, [])
})

test('新会话准备失败不切换现有上下文，后续可重新执行', async t => {
  const h = await runtime(t), oldId = h.record.sessionId
  h.config.persona = '新配置'
  const create = h.host.ctx.agents.create
  h.host.ctx.agents.create = async () => { throw new Error('无法创建会话') }
  let op = h.sync.request('new', [oldId])
  await waitFor(() => operationOf(h.sync, op.id)?.status === 'failed')
  assert.equal(h.record.sessionId, oldId)
  assert.equal(h.manager.find(oldId), h.record)
  assert.match(h.manager.systemPrompts.get(oldId).text, /旧人设/)
  h.host.ctx.agents.create = create
  op = h.sync.request('new', [oldId])
  await waitFor(() => operationOf(h.sync, op.id)?.status === 'done')
  assert.notEqual(h.record.sessionId, oldId)
})

test('借用会话切换时保存快照失败，保留旧 system 并释放准备中的新会话', async t => {
  const h = await runtime(t, { borrowed: true }), oldId = h.record.sessionId
  const oldAgent = h.record.agent
  assert.equal(h.record.owned, false)
  const systemOf = async agent => renderPrompt(await agent.ctx.get('systemPrompt').assemble(assembleContextFor(agent)))
  const original = await systemOf(oldAgent)
  h.config.persona = '新配置'
  const save = h.manager.systemPrompts.save
  h.manager.systemPrompts.save = snapshot => {
    if (snapshot.sessionId === oldId && snapshot.retired) {
      throw Object.assign(new Error('快照无写入权限'), { code: 'EACCES' })
    }
    return save(snapshot)
  }
  t.after(() => { h.manager.systemPrompts.save = save })
  await assert.rejects(h.manager.replaceSession(h.record), { code: 'EACCES' })
  assert.equal(h.manager.find(oldId), h.record)
  assert.equal(h.record.agent, oldAgent)
  assert.equal(h.manager.systemPrompts.get(oldId).retired, false)
  assert.equal(await systemOf(oldAgent), original)
  assert.deepEqual([...h.host.agents.keys()], [oldId])
  h.manager.systemPrompts.save = save
  await h.manager.replaceSession(h.record)
  assert.notEqual(h.record.sessionId, oldId)
  assert.match(await systemOf(h.record.agent), /新配置/)
  assert.doesNotMatch(await systemOf(oldAgent), /旧人设/)
  assert.equal(h.host.agents.get(oldId), oldAgent)
})

test('等待新建会话时收到的消息，切换后仍交付且保留本条消息来源', async t => {
  const h = await runtime(t), oldId = h.record.sessionId
  Object.assign(h.config, { persona: '切换后人设', privateMode: 'open', mergeWindowMs: 0, chatLog: false })
  let release
  const gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  h.record.agent.whenIdle = () => gate
  const op = h.sync.request('new', [oldId])
  await waitFor(() => operationOf(h.sync, op.id)?.status === 'running')
  const inbound = createInbound({ config: h.config, manager: h.manager, logger, client: { call: async () => ({}) } })
  t.after(() => inbound.dispose())
  await inbound({ post_type: 'message', message_type: 'private', self_id: 10001, user_id: 11001,
    message_id: 42, sender: { user_id: 11001, nickname: '测试用户' }, message: '切换时收到的新消息' })
  release()
  await waitFor(() => operationOf(h.sync, op.id)?.status === 'done')
  await h.record.queue
  assert.notEqual(h.record.sessionId, oldId)
  assert.match(JSON.stringify(h.record.agent.received), /切换时收到的新消息/)
  assert.match(h.record.agent.requests[0].system, /切换后人设/)
  assert.equal(h.record.lastMessageId, 42)
  assert.equal(h.record.lastSenderId, 11001)
})

test('账号身份在登录后才确定，也能识别上次中断的操作且不自动重放', async t => {
  const h = await runtime(t)
  h.config.persona = '新配置'
  const op = h.sync.request('new', [h.record.sessionId])
  const file = join(h.home, 'prompt-sync', `${op.id}.json`)
  await writeFile(file, JSON.stringify({ ...op, status: 'running' }))
  h.manager.selfId = ''
  await new Promise(resolve => setTimeout(resolve, 850))
  assert.equal(operationOf(h.sync, op.id).status, 'running')
  h.manager.selfId = '10001'
  await waitFor(() => operationOf(h.sync, op.id).status === 'failed')
  assert.match(operationOf(h.sync, op.id).sessions[0].error, /重启/)
  assert.equal(h.record.sessionId, op.sessions[0].sessionId)
})

test('真实插件设置 API 返回待同步列表，操作结果可轮询且主消息不再含人设', async t => {
  const root = await directory(t)
  const env = await createMockEnvironment({ root, config: { persona: 'API旧人设', contextGuard: false } })
  t.after(() => env.close())
  env.emitMessage({ text: '第一条', messageId: 1 })
  await waitFor(() => [...env.host.agents.values()].some(agent => agent.requests.length))
  const agent = [...env.host.agents.values()][0], oldSystem = agent.requests[0].system
  assert.doesNotMatch(JSON.stringify(agent.received), /API旧人设|你正在用 QQ 跟人聊天/)
  const save = async patch => (await fetch(`${env.url}/api/dsh-qq/settings`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch }) })).json()
  assert.deepEqual((await save({ persona: 'API旧人设' })).promptSync.pending, [])
  const result = await save({ persona: 'API新设定' })
  assert.equal(result.promptSync.pending.length, 1)
  assert.equal(result.systemChanged, true)
  assert.equal((await save({ persona: 'API新设定' })).systemChanged, false)
  assert.equal((await save({ rateLimitPerMin: 7 })).systemChanged, false)
  env.emitMessage({ text: '第二条', messageId: 2 })
  await waitFor(() => agent.requests.length === 2)
  assert.equal(agent.requests[1].system, oldSystem)
  const response = await fetch(`${env.url}/api/dsh-qq/prompt-sync`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'compact', sessionIds: [agent.id] }) })
  assert.equal(response.status, 202)
  await waitFor(async () => {
    const status = await (await fetch(`${env.url}/api/dsh-qq/status`)).json()
    return status.promptSync.operations.some(op => op.status === 'done')
  })
  env.emitMessage({ text: '压缩后', messageId: 3 })
  await waitFor(() => agent.requests.length === 3)
  assert.match(agent.requests[2].system, /API新设定/)
  const snapshotFiles = await readFile(join(root, 'dsh-qq', 'settings.json'), 'utf8')
  assert.match(snapshotFiles, /API新设定/)
})

test('首次分类也能只读新会话 system 快照，no 不写主历史或消费交接', async t => {
  const root = await directory(t), calls = []
  const llm = { async *stream(options) {
    calls.push(options)
    yield { type: 'text-delta', index: 0, text: 'no' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const env = await createMockEnvironment({ root, llm, config: { persona: '分类背景人设',
    addressClassifierEnabled: true, addressClassifierProvider: 'fixture', addressClassifierModel: 'judge' } })
  t.after(() => env.close())
  env.emitMessage({ text: '背景材料', messageId: 11 })
  await waitFor(() => calls.length === 1)
  const input = JSON.parse(calls[0].messages[0].content[0].text)
  assert.match(input.mainContext.header.system, /分类背景人设/)
  const agent = [...env.host.agents.values()][0]
  assert.deepEqual(agent.session.events, [])
  assert.deepEqual(agent.received, [])
  assert.doesNotMatch(calls[0].system, /分类背景人设/)
})
