import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import WebSocket from 'ws'
import { createMockEnvironment } from './mock-environment.mjs'
import { startMockNapcat } from './mock-napcat.mjs'
import { waitFor, textOf } from './mock-dsh.mjs'

const sent = env => env.napcat.calls.filter(c => c.action === 'send_private_msg' || c.action === 'send_group_msg')
async function setup(t, options) {
  const env = await createMockEnvironment(options)
  t.after(async () => {
    await env.close()
    const rel = relative(resolve(tmpdir()), resolve(env.root))
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('dsh-qq-sim-'))
    await rm(env.root, { recursive: true, force: true })
  })
  return env
}
async function idle(env) { for (const agent of env.host.agents.values()) await agent.whenIdle() }

test('设置预览加载正式组件和本地 React，浏览器连接限制在当前模拟器', async t => {
  const env = await setup(t)
  const response = await fetch(`${env.url}/settings`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/)
  const html = await response.text()
  const scripts = [...html.matchAll(/<script defer src="([^"]+)"/g)].map(match => match[1])
  assert.equal(scripts.length, 4)
  for (const path of scripts) {
    assert.ok(path.startsWith('/mock-assets/'))
    const script = await fetch(`${env.url}${path}`)
    assert.equal(script.status, 200, path)
    assert.match(script.headers.get('content-type'), /javascript/)
    const source = await script.text()
    if (path.endsWith('/client.js')) {
      assert.equal(source, await readFile(new URL('../client.js', import.meta.url), 'utf8'))
    } else assert.ok(source.length > 0)
  }
  assert.equal((await fetch(`${env.url}/mock-assets/package.json`)).status, 404)
})

test('真实插件可用：默认回复、预设工具、消息去重和宿主设置 API', async t => {
  const env = await setup(t)
  assert.ok(env.host.tools.has('qq_send_voice'))
  env.emitMessage({ text: '第一条', messageId: 1 })
  await waitFor(() => sent(env).length === 1)
  const agent = [...env.host.agents.values()][0]
  assert.ok(agent.scopedTools.has('read_image'))
  env.emitMessage({ text: '第一条', messageId: 1 })
  env.emitMessage({ text: '第二条', messageId: 2 })
  await waitFor(() => agent.received.length === 2); await idle(env)
  assert.equal(sent(env).length, 2)
  const response = await fetch(`${env.url}/api/dsh-qq/settings`)
  assert.equal(response.status, 200)
  const settings = await response.json()
  assert.ok(settings.meta.overridable.includes('groupImageBlock'))
  for (const groupTriggerWords of ['小助手', [1]]) {
    const invalid = await fetch(`${env.url}/api/dsh-qq/settings`, { method: 'POST', body: JSON.stringify({ patch: { groupTriggerWords } }) })
    assert.equal(invalid.status, 400)
  }
  const save = await fetch(`${env.url}/api/dsh-qq/settings`, { method: 'POST', body: JSON.stringify({ patch: { groupMentionOverrides: { '88888': false }, groupMessageIntervalMs: 30000, groupTriggerWords: ['小助手'] } }) })
  assert.equal(save.status, 200)
  assert.deepEqual((await save.json()).values.groupTriggerWords, ['小助手'])
  env.emitMessage({ scope: 'group', peerId: 88888, text: '小助手，免 @立即处理' })
  await waitFor(() => sent(env).length === 3)
  assert.match(JSON.stringify(sent(env).at(-1)), /88888/)
})

test('真实工具调用、预设文件读写和发图下载夹具，失败不会假装成功', async t => {
  const env = await setup(t)
  env.host.queueTurn([
    { type: 'tool', name: 'write', args: { path: '测试.md', content: '测试文件' } },
    { type: 'tool', name: 'read', args: { path: '测试.md' } },
    { type: 'tool', name: 'qq_send', args: { text: '<text>工具回复</text>' } },
    { type: 'text', text: '不能重复发送的正文' },
  ])
  env.emitMessage({ text: '请调用工具', image: true })
  await waitFor(() => sent(env).length === 1); await idle(env)
  const agent = [...env.host.agents.values()][0]
  assert.equal(agent.results[1].result.text, '测试文件')
  assert.match(textOf(agent.received[0]), /已保存到本机|图片|\.png/)
  assert.match(JSON.stringify(sent(env)[0]), /工具回复/)
  assert.doesNotMatch(JSON.stringify(sent(env)), /不能重复发送|<text>/)
  env.host.queueTurn([{ type: 'tool', name: 'read', args: { path: '../不能越界.md' } }])
  env.emitMessage({ text: '越界测试' })
  await waitFor(() => agent.received.length === 2); await idle(env)
  assert.match(JSON.stringify(agent.session.events.at(-1)), /路径超出/)
})

test('屏蔽图片仍让模型知道发过图，不请求图片文件', async t => {
  const env = await setup(t, { config: { groupMentionOverrides: { '88888': false }, groupMessageIntervalMs: 1, groupImageBlock: ['88888:11001'] } })
  env.emitMessage({ scope: 'group', peerId: 88888, text: '', image: true })
  await waitFor(() => sent(env).length === 1)
  const agent = [...env.host.agents.values()][0]
  assert.match(textOf(agent.received[0]), /\[图片\]/)
  assert.doesNotMatch(textOf(agent.received[0]), /\.png|已保存/)
})

test('问答和审批走真实插件通道，可从模拟 QQ 回复', async t => {
  const env = await setup(t)
  env.host.queueTurn([{ type: 'question', questions: [{ id: 'q1', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }] }])
  env.emitMessage({ text: '请问我' })
  await waitFor(() => sent(env).length === 1)
  env.emitMessage({ text: '2' })
  const agent = [...env.host.agents.values()][0]
  await waitFor(() => agent.results.length === 1)
  assert.deepEqual(agent.results[0].result.answers[0].selected, ['乙'])
  await idle(env)
  env.host.queueTurn([{ type: 'approval', command: 'mock-only-operation' }])
  env.emitMessage({ text: '请求审批' })
  await waitFor(() => sent(env).length === 2)
  assert.match(JSON.stringify(sent(env).at(-1)), /mock-only-operation/)
  env.emitMessage({ text: '通过' })
  await waitFor(() => agent.results.length === 2)
  assert.equal(agent.results[1].result, 'allowed-once')
})

test('空间发布和私聊历史工具走真实实现，NapCat 记录可见范围与日限', async t => {
  const env = await setup(t)
  const post = { type: 'tool', name: 'qq_qzone_send', args: { text: '模拟空间说说', images: [`${env.napcat.mediaUrl}/fixture.png`], privacy: 'private' } }
  env.host.queueTurn([post, { type: 'tool', name: 'qq_history', args: {} }])
  env.emitMessage({ text: '测试发布和流水' })
  await waitFor(() => env.napcat.posts.length === 1)
  const agent = [...env.host.agents.values()][0]; await idle(env)
  assert.equal(env.napcat.posts[0].ugc_right, 64)
  assert.equal(agent.results[1].result.ok, true)
  assert.equal(JSON.parse(await readFile(join(env.root, 'dsh-qq', 'qzone-state.json'), 'utf8')).count, 1)
})

test('统一历史工具在完整消息链查询收发正文、工具跨目标发送，关闭 Markdown 流水仍有效', async t => {
  const env = await setup(t, { config: { chatLog: false, ownerIds: ['11001'] } })
  const attachment = join(env.root, 'history-fixture.txt')
  await writeFile(attachment, '测试文件内容')
  env.emitMessage({ text: '请记住这条测试原文', steps: [{ type: 'text', text: '这是机器人测试回复' }] })
  await waitFor(() => sent(env).length === 1); await idle(env)
  env.host.queueTurn([
    { type: 'tool', name: 'qq_send', args: { to: 'group:70001', text: '发往目标群的测试消息' } },
    { type: 'tool', name: 'qq_send_file', args: { file: attachment, name: '测试附件.txt' } },
    { type: 'tool', name: 'qq_history', args: {} },
    { type: 'tool', name: 'qq_history', args: { chat: 'group:70001', include_status: true } },
  ])
  env.emitMessage({ text: '现在查询记录' })
  const agent = [...env.host.agents.values()][0]
  await waitFor(() => agent.results.length === 4); await idle(env)
  const current = agent.results[2].result.messages
  assert.ok(current.some(row => row.direction === 'incoming' && row.text.includes('请记住这条测试原文')))
  assert.ok(current.some(row => row.direction === 'outgoing' && row.text === '这是机器人测试回复' && row.confirmed))
  assert.ok(current.some(row => row.direction === 'outgoing' && row.text === '[文件 测试附件.txt]' && row.confirmed))
  assert.ok(current.every(row => row.text !== '发往目标群的测试消息'))
  const target = agent.results[3].result.messages
  assert.equal(target.length, 1)
  assert.equal(target[0].text, '发往目标群的测试消息')
  assert.equal(target[0].status, 'sent')
  for (const old of ['qq_messages', 'qq_group_history', 'qq_private_history']) assert.equal(env.host.tools.has(old), false)
})

test('重载恢复会话和预设，后续一条消息只处理一次；上下文超限保留会话', async t => {
  const env = await setup(t)
  env.emitMessage({ text: '重载前' })
  await waitFor(() => sent(env).length === 1); await idle(env)
  const id = [...env.host.agents.keys()][0]
  await env.reload()
  env.emitMessage({ text: '重载后' })
  await waitFor(() => sent(env).length === 2); await idle(env)
  assert.deepEqual([...env.host.agents.keys()], [id])
  const agent = env.host.agents.get(id)
  assert.equal(agent.received.length, 2)
  assert.ok(agent.scopedTools.has('read_image'))
  env.host.queueTurn([{ type: 'error', message: 'CONTEXT_WINDOW_EXCEEDED' }])
  env.emitMessage({ text: '触发超限' })
  await waitFor(() => sent(env).length === 3)
  env.emitMessage({ text: '原会话继续' })
  await waitFor(() => sent(env).length === 4)
  assert.equal([...env.host.agents.keys()][0], id)
  assert.match(JSON.stringify(agent.received), /触发超限/)
})

test('断线重连与 API 失败可控，模拟地址不能通过设置改成真实地址', async t => {
  const env = await setup(t)
  const url = env.config.wsUrl
  const response = await fetch(`${env.url}/api/dsh-qq/settings`, { method: 'POST', body: JSON.stringify({ patch: { wsUrl: 'ws://127.0.0.1:1' } }) })
  assert.equal(response.status, 200)
  assert.equal(env.config.wsUrl, url)
  // 清除持久化的无效覆盖，重载时同样不会应用到只读连接字段。
  await writeFile(join(env.root, 'dsh-qq', 'settings.json'), '{}')
  env.napcat.failNext('send_private_msg', { wording: '模拟失败' })
  env.emitMessage({ text: '发送失败' })
  await waitFor(() => env.host.logs.some(log => log.text.includes('模拟失败')))
  env.napcat.disconnectClients()
  await waitFor(() => env.napcat.clientCount === 0)
  await waitFor(() => env.napcat.clientCount === 1, { timeout: 5000 })
  env.emitMessage({ text: '恢复后' })
  await waitFor(() => [...env.host.agents.values()][0].received.length === 2)
  await idle(env)
  assert.match(textOf([...env.host.agents.values()][0].received[1]), /没送出去|没能送出去/)
})

test('NapCat 严格处理鉴权、未知 action 和已处理但回执丢失', async t => {
  const server = await startMockNapcat({ port: 0, token: 'mock-token', quiet: true }).start()
  t.after(() => server.close())
  const denied = new WebSocket(server.url)
  const code = await new Promise(resolve => denied.once('close', resolve))
  assert.equal(code, 1008)
  const ws = new WebSocket(server.url, { headers: { Authorization: 'Bearer mock-token' } })
  await new Promise(resolve => ws.once('open', resolve))
  t.after(() => ws.terminate())
  ws.send(JSON.stringify({ action: 'not_implemented', echo: 'bad' }))
  const response = JSON.parse(await new Promise(resolve => ws.once('message', resolve)))
  assert.equal(response.status, 'failed')
  server.failNext('send_qzone_msg', { afterApply: true, drop: true })
  ws.send(JSON.stringify({ action: 'send_qzone_msg', params: { content: '仅本地', ugc_right: 64 }, echo: 'lost' }))
  await waitFor(() => server.posts.length === 1)
  assert.equal(server.posts[0].content, '仅本地')
})
