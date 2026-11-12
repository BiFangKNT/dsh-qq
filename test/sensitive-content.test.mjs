import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm, readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createMockEnvironment } from './mock-environment.mjs'
import { waitFor } from './mock-dsh.mjs'
import { sensitiveContentNotice } from '../src/audit.js'
import { resolvePeerWorkspace } from '../src/workspace.js'

const sent = env => env.napcat.calls.filter(call => ['send_private_msg', 'send_group_msg'].includes(call.action))
const content = call => call.params.message.filter(seg => seg.type === 'text').map(seg => seg.data.text).join('')
async function setup(t, config = {}) {
  const env = await createMockEnvironment({ autoReply: false, config })
  t.after(async () => {
    await env.close()
    const rel = relative(resolve(tmpdir()), resolve(env.root))
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('dsh-qq-sim-'))
    await rm(env.root, { recursive: true, force: true })
  })
  let messageId = 0
  async function turn(steps, extra = {}) {
    const before = [...env.host.agents.values()].reduce((n, a) => n + a.received.length, 0)
    env.emitMessage({ text: '测试回复', steps, messageId: ++messageId, ...extra })
    await waitFor(() => [...env.host.agents.values()].reduce((n, a) => n + a.received.length, 0) > before)
    for (const agent of env.host.agents.values()) await agent.whenIdle()
  }
  return { env, turn }
}

test('真实发送链路：私聊和群聊 /cwd 正常回复，路径讨论也不再误拦', async t => {
  const { env, turn } = await setup(t, { ownerIds: [], streamReply: false })
  env.emitMessage({ text: '/cwd', messageId: 101 })
  await waitFor(() => sent(env).length === 1)
  assert.match(content(sent(env)[0]), /目录：/)
  assert.ok(content(sent(env)[0]).includes(env.root))
  env.emitMessage({ scope: 'group', peerId: 22001, text: ' /cwd', atSelf: true, messageId: 102 })
  await waitFor(() => sent(env).length === 2)
  assert.equal(sent(env)[1].action, 'send_group_msg')
  assert.match(content(sent(env)[1]), /目录：/)
  await turn([{ type: 'text', text: '示例路径 C:/Users/example/config 和 /home/example/config，password: example123。' }])
  assert.equal(sent(env).length, 3)
  assert.match(content(sent(env)[2]), /C:\/Users\/example/)
})

test('已知连接令牌被阻止：只发送固定提示，发送记录及审计日志不含原文', async t => {
  const { env, turn } = await setup(t)
  const secret = env.config.accessToken
  await turn([{ type: 'text', text: `连接的私密值是 ${secret}。` }])
  assert.equal(sent(env).length, 1)
  assert.equal(content(sent(env)[0]), sensitiveContentNotice)
  const logs = JSON.stringify(env.snapshot().logs)
  assert.ok(!logs.includes(secret))
  assert.ok(!logs.includes('连接的私密值是'))
  assert.match(logs, /configured-credential/)
  const logDir = join(env.root, '会话', 'logs')
  const diskLogs = (await Promise.all((await readdir(logDir)).map(file => readFile(join(logDir, file), 'utf8')))).join('\n')
  assert.ok(!diskLogs.includes(secret))
  // QQ 发送回执也只记固定提示，不把被阻止的原文当成已发送。
  const chatDir = join(resolvePeerWorkspace(env.config, 'private', '11001'), '聊天记录')
  const chatLogs = (await Promise.all((await readdir(chatDir)).map(file => readFile(join(chatDir, file), 'utf8')))).join('\n')
  assert.ok(!chatLogs.includes(secret))
  assert.ok(chatLogs.includes(sensitiveContentNotice))
  assert.equal([...env.host.agents.values()][0].received.length, 1)
  await turn([{ type: 'text', text: `群聊也不能发送 ${secret}。` }], { scope: 'group', peerId: 22001, atSelf: true })
  assert.equal(sent(env).at(-1).action, 'send_group_msg')
  assert.equal(content(sent(env).at(-1)), sensitiveContentNotice)
})

test('流式回复命中后停止该轮后续文字，下一轮恢复正常', async t => {
  const { env, turn } = await setup(t)
  const text = `不能发送这个值 ${env.config.accessToken}。后续正文不应继续发送。`
  await turn([
    { type: 'chunk', text: text.slice(0, 12) },
    { type: 'chunk', text: text.slice(12) },
    { type: 'text', text },
  ])
  assert.deepEqual(sent(env).map(content), [sensitiveContentNotice])
  await turn([{ type: 'text', text: '下一轮可以正常聊天。' }])
  assert.equal(sent(env).length, 2)
  assert.equal(content(sent(env)[1]), '下一轮可以正常聊天。')
})

for (const name of ['qq_send', 'qq_reply', 'qq_send_voice', 'qq_qzone_send']) {
  test(`${name} 在实际发送或合成之前阻止凭据，并同时通知 QQ 和工具调用方`, async t => {
    const { env, turn } = await setup(t)
    const secret = env.config.accessToken
    await turn([{ type: 'tool', name, args: { text: `不要发送 ${secret}` } }])
    assert.deepEqual(sent(env).map(content), [sensitiveContentNotice])
    assert.equal(env.napcat.posts.length, 0)
    assert.ok(!JSON.stringify(env.napcat.calls).includes(secret))
    const agent = [...env.host.agents.values()][0]
    const result = agent.session.events.find(event => event.type === 'tool/result')
    assert.match(result.data.error.message, /configured-credential/)
    assert.equal(result.data.error.code, 'QQ_SENSITIVE_CONTENT')
    assert.ok(!result.data.error.message.includes(secret))
    assert.ok(!JSON.stringify(env.snapshot().logs).includes(secret))
  })
}

test('自定义规则继续生效；即使匹配全部文本，也只发一次固定提示', async t => {
  const { env, turn } = await setup(t, { auditExtraPatterns: ['.'] })
  await turn([{ type: 'text', text: '普通正文' }])
  assert.deepEqual(sent(env).map(content), [sensitiveContentNotice])
  await turn([{ type: 'tool', name: 'qq_send', args: { text: '普通工具正文' } }])
  assert.deepEqual(sent(env).map(content), [sensitiveContentNotice, sensitiveContentNotice])
  const rejections = env.snapshot().logs.filter(log => log.text.includes('外发敏感内容已阻止'))
  assert.equal(rejections.length, 2)
  assert.ok(rejections.every(log => log.text.includes('custom-1')))
})

test('关闭检查同时放行模型和工具', async t => {
  const { env, turn } = await setup(t, { auditOutbound: false, streamReply: false })
  const text = `测试值 ${env.config.accessToken}`
  await turn([{ type: 'text', text }])
  await turn([{ type: 'tool', name: 'qq_send', args: { text } }])
  assert.deepEqual(sent(env).map(content), [text, text])
  assert.equal(env.snapshot().logs.filter(log => log.text.includes('外发敏感内容已阻止')).length, 0)
})
