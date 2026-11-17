import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import WebSocket from 'ws'
import { createMockEnvironment } from './mock-environment.mjs'
import { startMockNapcat } from './mock-napcat.mjs'
import { waitFor, textOf } from './mock-dsh.mjs'
import { listFaces } from '../src/faces.js'

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

test('引用、图片和商城表情转录只留事实，关闭表情发送仍自动登记且不推荐工具', async t => {
  const env = await setup(t, { autoReply: false, config: { stickerEnabled: false, faceCollectHint: '', quoteReply: true } })
  env.napcat.setQuoted(11, { userId: 11002, nickname: '乙', text: '约好周六讨论' })
  const message = [
    { type: 'reply', data: { id: '11' } },
    { type: 'text', data: { text: '这是原图和商城表情' } },
    { type: 'image', data: { url: `${env.napcat.mediaUrl}/fixture.png` } },
    { type: 'mface', data: { emoji_id: 'fixture-face', emoji_package_id: 'fixture-pack', summary: '测试表情' } },
  ]
  const send = async (messageId, segments) => {
    const count = [...env.host.agents.values()].reduce((sum, agent) => sum + agent.received.length, 0)
    env.emitMessage({ messageId, message: segments, steps: [] })
    await waitFor(() => [...env.host.agents.values()].reduce((sum, agent) => sum + agent.received.length, 0) > count)
    await idle(env)
    return [...env.host.agents.values()][0]
  }
  const agent = await send(100, message)
  const body = textOf(agent.received[0])
  assert.match(body, /引用 乙 \(11002\)：约好周六讨论/)
  assert.match(body, /1 张图片，已存到本机：[\s\S]*\.png/)
  assert.match(body, /对方发来商城表情/)
  assert.match(body, /已自动登记 1 个新商城表情/)
  assert.doesNotMatch(body, /read_image|qq_mface|qq_keep_face|引用别人|顺着这个情绪|不要描述|想发就用/)
  assert.equal(listFaces(env.config).length, 1)
  assert.equal(agent.requests[0].tools.some(tool => ['qq_faces', 'qq_mface'].includes(tool.name)), false)
  assert.match(agent.requests[0].context, /表情包状态】使用已关闭/)
  assert.match(agent.requests[0].system, /read_image[\s\S]*引用别人也可能是在向你提问/)
  const system = agent.requests[0].system
  const response = await fetch(`${env.url}/api/dsh-qq/settings`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { stickerEnabled: true, faceCollectHint: '虚构的蓝色方块' } }) })
  assert.equal(response.status, 200)
  await send(101, message.slice(3))
  assert.equal(listFaces(env.config).length, 1, '重复商城表情不会重复登记')
  assert.doesNotMatch(textOf(agent.received[1]), /已自动登记|qq_mface|虚构的蓝色方块/)
  assert.equal(agent.requests.at(-1).system, system)
  assert.match(agent.requests.at(-1).context, /使用已开启[\s\S]*测试表情[\s\S]*【本轮条件】[\s\S]*虚构的蓝色方块/)
  assert.equal(agent.requests.at(-1).tools.some(tool => tool.name === 'qq_mface'), true)
  assert.doesNotMatch(JSON.stringify(agent.session.deriveMessages()), /【本轮条件】|虚构的蓝色方块|顺着这个情绪|想发就用/)
})

test('资料设置API与实际mock模型工具调用共用来源，更新文件后返回新内容', async t => {
  const env = await setup(t)
  const file = join(env.root, 'reference.md')
  await writeFile(file, '# 泡泡机\n泡泡机是一种虚构仪器。')
  const api = (path, body) => fetch(`${env.url}/api/dsh-qq/${path}`, body ? { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined).then(response => response.json())
  assert.equal((await api('sources')).sources.length, 0)
  await api('sources', { action: 'save', source: { selfId: '10001', scope: 'chat', chat: { scope: 'private', peerId: '11001' },
    kind: 'file', path: file, label: '仪器参考' } })
  // 沿用模拟器的真实入站→工具执行→续调→出站路径，工具选择不改 system。
  const before = sent(env).length
  env.emitMessage({ text: '查泡泡机', steps: [{ type: 'tool', name: 'qq_search', args: { query: '泡泡机' } },
    { type: 'text', text: '查询结果已读取' }] })
  await waitFor(() => sent(env).length > before)
  await idle(env)
  const agent = [...env.host.agents.values()][0]
  assert.match(agent.results[0].result.text, /虚构仪器/)
  const system = agent.requests[0].system
  const hit = JSON.parse(agent.results[0].result.text).results[0]
  env.emitMessage({ text: '读完整原文', steps: [{ type: 'tool', name: 'qq_search', args: {
    action: 'read', sourceId: hit.sourceId, documentId: hit.documentId, version: hit.version,
  } }, { type: 'text', text: '完整原文已读取' }] })
  await waitFor(() => sent(env).length > before + 1)
  await idle(env)
  assert.equal(JSON.parse(agent.results.at(-1).result.text).text, await readFile(file, 'utf8'))
  await writeFile(file, '# 泡泡机\n泡泡机的新版说明。')
  env.emitMessage({ text: '再查泡泡机', steps: [{ type: 'tool', name: 'qq_search', args: { query: '泡泡机' } },
    { type: 'text', text: '已查看新版' }] })
  await waitFor(() => sent(env).length > before + 2)
  await idle(env)
  assert.match(agent.results.at(-1).result.text, /新版说明/)
  assert.equal(agent.requests.at(-1).system, system)
})

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
    const invalid = await fetch(`${env.url}/api/dsh-qq/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { groupTriggerWords } }) })
    assert.equal(invalid.status, 400)
  }
  const save = await fetch(`${env.url}/api/dsh-qq/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { groupMentionOverrides: { '88888': false }, groupMessageIntervalMs: 30000, groupTriggerWords: ['小助手'] } }) })
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
  assert.match(agent.results.at(-1).error.message, /路径超出/)
  assert.equal(agent.results.at(-1).isError, true)
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

test('群审批仅授权账号协议@后可确认，群问答只接受原发言人协议@后的答案', async t => {
  const env = await setup(t, { autoReply: false })
  env.emitMessage({ scope: 'group', userId: 11002, atSelf: true, text: '请求审批', steps: [{ type: 'approval', command: 'mock-only-operation' }] })
  await waitFor(() => sent(env).length === 1)
  const agent = [...env.host.agents.values()][0]
  assert.match(JSON.stringify(sent(env)[0]), /仅授权账号/)
  for (const message of [
    { userId: 11002, atSelf: true, text: '通过' },
    { userId: 11001, atSelf: false, text: '通过' },
    { userId: 11001, atSelf: true, text: '好' },
    { userId: 11001, atSelf: false, text: '@模拟机器人 通过' },
  ]) env.emitMessage({ scope: 'group', ...message })
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(agent.results.length, 0)
  env.emitMessage({ scope: 'group', userId: 11001, atSelf: true, text: '通过' })
  await waitFor(() => agent.results.length === 1)
  assert.equal(agent.results[0].result, 'allowed-once')
  await idle(env)
  env.emitMessage({ scope: 'group', userId: 11002, atSelf: true, text: '提个问题', steps: [{ type: 'question',
    questions: [{ id: 'group-question', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }] }] })
  await waitFor(() => sent(env).length === 2)
  env.emitMessage({ scope: 'group', userId: 11001, atSelf: true, text: '1' })
  env.emitMessage({ scope: 'group', userId: 11002, text: '1' })
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(agent.results.length, 1)
  env.emitMessage({ scope: 'group', userId: 11002, atSelf: true, text: '2' })
  await waitFor(() => agent.results.length === 2)
  assert.deepEqual(agent.results[1].result, { answers: [{ id: 'group-question', selected: ['乙'] }] })
})

for (const scope of ['group', 'private']) {
  test(`${scope} 数字选项不受机器人 @ 位置影响，自由回答中的提及保留`, async t => {
    const env = await setup(t, { autoReply: false })
    const options = [{ label: '甲' }, { label: '乙' }]
    const messages = [
      '[CQ:at,qq=10001]2',
      '2[CQ:at,qq=10001]',
      '1[CQ:at,qq=10001]2',
      '1,[CQ:at,qq=10001]2',
      '通知 [CQ:at,qq=11003]，完成后 [CQ:at,qq=10001] 确认',
    ]
    env.emitMessage({ scope, userId: 11002, atSelf: scope === 'group', text: '请提问', steps: [{ type: 'question',
      questions: messages.map((_, index) => ({ id: `q${index}`, question: '选哪个？', options, multiSelect: true })) }] })
    await waitFor(() => sent(env).length === 1)
    const agent = [...env.host.agents.values()][0]
    for (const [index, message] of messages.entries()) {
      env.emitMessage({ scope, userId: 11002, message })
      if (index < messages.length - 1) await waitFor(() => sent(env).length === index + 2)
    }
    await waitFor(() => agent.results.length === 1)
    assert.deepEqual(agent.results[0].result, { answers: [
      { id: 'q0', selected: ['乙'] }, { id: 'q1', selected: ['乙'] },
      { id: 'q2', selected: ['甲', '乙'] }, { id: 'q3', selected: ['甲', '乙'] },
      { id: 'q4', selected: [], custom: '通知 @11003，完成后 @机器人 确认' },
    ] })
    await idle(env)
    assert.equal(agent.received.length, 1)
  })

  test(`${scope} 工具问答接收带成员提及的自由回答，不把答案交给主模型`, async t => {
    const env = await setup(t, { autoReply: false })
    env.emitMessage({ scope, userId: 11002, atSelf: scope === 'group', text: '请提问', steps: [{ type: 'question',
      questions: [{ id: 'member', question: '通知谁？' }, { id: 'followup', question: '然后呢？' }] }] })
    await waitFor(() => sent(env).length === 1)
    const agent = [...env.host.agents.values()][0]
    env.emitMessage({ scope, userId: 11002, message: [
      { type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: '通知 ' } },
      { type: 'at', data: { qq: '11003' } },
    ] })
    await waitFor(() => sent(env).length === 2)
    env.emitMessage({ scope, userId: 11002,
      message: '[CQ:at,qq=10001] 完成后 [CQ:at,qq=10001] 确认' })
    await waitFor(() => agent.results.length === 1)
    assert.deepEqual(agent.results[0].result, { answers: [
      { id: 'member', selected: [], custom: '通知 @11003' },
      { id: 'followup', selected: [], custom: '完成后 @机器人 确认' },
    ] })
    await idle(env)
    assert.equal(agent.received.length, 1)
  })
}

test('工具开关通过设置保存，既有会话下次请求刷新且 system 保持锁定，重载后保留', async t => {
  const env = await setup(t, { autoReply: false })
  const sendTurn = async text => {
    const before = [...env.host.agents.values()].reduce((sum, agent) => sum + agent.requests.length, 0)
    env.emitMessage({ text, steps: [] })
    await waitFor(() => [...env.host.agents.values()].reduce((sum, agent) => sum + agent.requests.length, 0) > before)
    await idle(env)
    return [...env.host.agents.values()][0]
  }
  const initial = await sendTurn('第一轮')
  const system = initial.requests.at(-1).system
  assert.ok(initial.requests.at(-1).tools.some(tool => tool.name === 'qq_face'))
  assert.ok(!initial.requests.at(-1).tools.some(tool => ['qq_reply', 'qq_qzone_send', 'qq_meme'].includes(tool.name)))
  const response = await fetch(`${env.url}/api/dsh-qq/settings`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { qqInteractionEnabled: false, stickerEnabled: false, qzoneEnabled: true, faceCollectHint: '猫猫梗图' } }) })
  assert.equal(response.status, 200)
  const settings = await response.json()
  assert.equal(settings.systemChanged, false)
  const updated = await sendTurn('第二轮')
  assert.equal(updated.id, initial.id)
  const names = updated.requests.at(-1).tools.map(tool => tool.name)
  for (const name of ['qq_face', 'qq_poke', 'qq_react', 'qq_like', 'qq_faces', 'qq_mface']) assert.ok(!names.includes(name))
  assert.ok(names.includes('qq_qzone_send'))
  assert.ok(names.includes('qq_keep_face'))
  assert.equal(updated.requests.at(-1).system, system)
  assert.match(updated.requests.at(-1).context, /猫猫梗图/)
  assert.doesNotMatch(JSON.stringify(updated.received), /猫猫梗图/)
  await env.reload()
  const restored = await sendTurn('重载后')
  assert.equal(restored.id, initial.id)
  assert.equal(restored.requests.at(-1).tools.some(tool => tool.name === 'qq_face'), false)
  assert.equal(restored.requests.at(-1).tools.some(tool => tool.name === 'qq_qzone_send'), true)
})

test('qq_send 引用当前已存消息，不混入其他群的引用，工具正文不重复发送', async t => {
  const env = await setup(t, { autoReply: false })
  env.emitMessage({ scope: 'group', peerId: 70001, atSelf: true, messageId: -17, text: '请引用这条消息', steps: [
    { type: 'tool', name: 'qq_send', args: { text: '引用回复', message_id: -17 } },
    { type: 'text', text: '引用回复' },
  ] })
  await waitFor(() => [...env.host.agents.values()][0]?.results.length === 1); await idle(env)
  const agent = [...env.host.agents.values()][0]
  assert.equal(agent.results[0].result.ok, true)
  assert.equal(sent(env).length, 1)
  assert.deepEqual(sent(env)[0].params.message[0], { type: 'reply', data: { id: '-17' } })
  env.emitMessage({ scope: 'group', peerId: 70001, atSelf: true, text: '不能引用另一群的消息', steps: [
    { type: 'tool', name: 'qq_send', args: { text: '不应发出', to: 'group:70002', message_id: -17 } },
  ] })
  await waitFor(() => agent.received.length === 2); await idle(env)
  assert.ok(sent(env).every(call => call.params.group_id === 70001))
  assert.ok(!sent(env).some(call => call.params.message.some(segment => segment.data.text === '不应发出')))
})

test('空间发布和私聊历史工具走真实实现，NapCat 记录可见范围与日限', async t => {
  const env = await setup(t, { config: { qzoneEnabled: true } })
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

test('跨聊天发送不启动目标 Agent、不覆盖发起聊天的撤回目标，并保留结果说明', async t => {
  const env = await setup(t, { autoReply: false, config: { chatLog: false } })
  env.emitMessage({ text: '发起私聊', steps: [{ type: 'text', text: '原先的私聊回复' }] })
  await waitFor(() => sent(env).length === 1); await idle(env)
  const agent = [...env.host.agents.values()][0]
  const oldMessage = [...env.napcat.messages.values()].find(message => Array.isArray(message.message) &&
    message.message.some(segment => segment.type === 'text' && segment.data.text === '原先的私聊回复'))
  assert.ok(oldMessage)
  env.emitMessage({ text: '请发送到另一个群', steps: [
    { type: 'tool', name: 'qq_send', args: { to: 'group:70001', text: '目标群收到的内容' } },
    { type: 'tool', name: 'qq_recall', args: {} },
    { type: 'text', text: '已发送到目标群。' },
  ] })
  await waitFor(() => agent.received.length === 2); await idle(env)
  assert.equal(env.host.agents.size, 1)
  const recall = env.napcat.calls.find(call => call.action === 'delete_msg')
  assert.equal(recall.params.message_id, oldMessage.message_id)
  assert.equal(agent.results[1].result.ok, true)
  assert.equal(sent(env).length, 3)
  assert.equal(sent(env)[1].params.group_id, 70001)
  assert.match(JSON.stringify(sent(env)[2]), /已发送到目标群/)
})

test('跨聊天发送失败记录在目标聊天，不记为已送达，不自动重试且可说明失败', async t => {
  const env = await setup(t, { autoReply: false, config: { chatLog: false } })
  env.napcat.failNext('send_group_msg', { wording: '模拟目标发送失败' })
  env.emitMessage({ text: '测试发送失败', steps: [
    { type: 'tool', name: 'qq_send', args: { to: 'group:70001', text: '未送达的目标内容' } },
    { type: 'tool', name: 'qq_history', args: { chat: 'group:70001', include_status: true } },
    { type: 'tool', name: 'qq_history', args: {} },
    { type: 'text', text: '发送失败，请稍后检查。' },
  ] })
  await waitFor(() => [...env.host.agents.values()][0]?.results.length === 3); await idle(env)
  const agent = [...env.host.agents.values()][0]
  assert.equal(agent.results[0].isError, true)
  const target = agent.results[1].result.messages
  assert.equal(target.length, 1)
  assert.equal(target[0].text, '未送达的目标内容')
  assert.equal(target[0].confirmed, false)
  assert.equal(target[0].status, 'rejected')
  assert.ok(agent.results[2].result.messages.every(row => row.text !== '未送达的目标内容'))
  assert.equal(env.napcat.calls.filter(call => call.action === 'send_group_msg').length, 1)
  assert.match(JSON.stringify(sent(env).at(-1)), /发送失败/)
})

for (const messageId of [-71, 0]) {
  test(`成功回执消息 ID 为 ${messageId} 时，工具和目标历史均确认发送`, async t => {
    const env = await setup(t, { autoReply: false, config: { chatLog: false } })
    env.napcat.failNext('send_group_msg', { afterApply: true, data: { message_id: messageId } })
    env.emitMessage({ text: '测试有符号回执', steps: [
      { type: 'tool', name: 'qq_send', args: { to: 'group:70001', text: '目标群的消息' } },
      { type: 'tool', name: 'qq_history', args: { chat: 'group:70001', include_status: true } },
    ] })
    await waitFor(() => [...env.host.agents.values()][0]?.results.length === 2); await idle(env)
    const agent = [...env.host.agents.values()][0]
    assert.equal(agent.results[0].result.ok, true)
    assert.equal(agent.results[0].result.messageId, messageId)
    const message = agent.results[1].result.messages[0]
    assert.equal(message.status, 'sent')
    assert.equal(message.confirmed, true)
    assert.equal(message.id, String(messageId))
    assert.equal(env.napcat.calls.filter(call => call.action === 'send_group_msg').length, 1)
  })
}

test('消息实际发出但回执缺少消息 ID 时，工具和历史均标为未确认，不重发', async t => {
  const env = await setup(t, { autoReply: false, config: { chatLog: false } })
  env.napcat.failNext('send_group_msg', { afterApply: true, data: {} })
  env.emitMessage({ text: '测试异常回执', steps: [
    { type: 'tool', name: 'qq_send', args: { to: 'group:70001', text: '回执缺失的目标消息' } },
    { type: 'tool', name: 'qq_history', args: { chat: 'group:70001', include_status: true } },
  ] })
  await waitFor(() => [...env.host.agents.values()][0]?.results.length === 2); await idle(env)
  const agent = [...env.host.agents.values()][0]
  assert.equal(agent.results[0].isError, true)
  assert.match(agent.results[0].error.message, /未确认/)
  assert.equal(agent.results[1].result.messages[0].status, 'uncertain')
  assert.equal(agent.results[1].result.messages[0].confirmed, false)
  assert.equal(env.napcat.calls.filter(call => call.action === 'send_group_msg').length, 1)
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
  const response = await fetch(`${env.url}/api/dsh-qq/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { wsUrl: 'ws://127.0.0.1:1' } }) })
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
