import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools } from '../src/tools.js'
import { rememberFaces, listFaces } from '../src/faces.js'
import { faceCollectRule } from '../src/prompts.js'

const exec = { agent: { session: { id: 'main' } } }
function fixture(t, { scope = 'private', extra = {}, platform = 'win32' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qq-tool-send-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = { cwd: root, replyToPrivate: true, privateMode: 'open', groupMode: 'open',
    ownerIds: ['10001'], voiceEnabled: true, ...extra }
  const source = { selfId: '90001', scope, peerId: '10001', sessionId: 'main', lastSentMessageId: 11 }
  const group = { selfId: '90001', scope: 'group', peerId: '70001', sessionId: 'group', lastSentMessageId: 22 }
  const privateChat = { selfId: '90001', scope: 'private', peerId: '10002', sessionId: 'private', lastSentMessageId: 33 }
  const records = [source, group, privateChat], tools = new Map(), conditions = new Map(), calls = [], notes = [], memories = [], activity = [], proactive = [], synthesis = []
  const manager = { selfId: '90001', find: id => records.find(record => record.sessionId === id),
    findByPeer: (kind, peerId) => records.find(record => record.scope === kind && record.peerId === String(peerId)),
    memory: { noteSent: (...args) => memories.push(args) } }
  const h = { config, source, group, privateChat, manager, tools, calls, notes, memories, activity, proactive, synthesis,
    warnings: [], response: { message_id: 71 }, beforeReply: null, beforeSynthesis: null }
  registerTools({ get: name => name === 'tools' ? { register: (tool, options) => { tools.set(tool.name, tool); conditions.set(tool.name, options.when) } } : null }, {
    config, manager, home: root, platform, logger: { info() {}, warn: message => h.warnings.push(message), debug() {} },
    client: { async call(action, params) {
      calls.push({ action, params })
      await h.beforeReply?.()
      if (action === 'get_msg') return h.quoted ?? { message_id: params.message_id, message_type: source.scope,
        ...(source.scope === 'group' ? { group_id: Number(source.peerId) } : { target_id: Number(source.peerId) }),
        sender: { user_id: Number(source.selfId) } }
      if (h.response instanceof Error) throw h.response
      return h.response
    } },
    noteSelfSaid: (...args) => notes.push(args), wake: {
      noteOutbound: record => activity.push(record), noteProactiveDelivered: record => proactive.push(record),
    },
    synthesize: async text => { synthesis.push(text); await h.beforeSynthesis?.(); return Buffer.from('mock audio') },
  })
  h.send = (name, to) => tools.get(name).execute({ text: '测试发送内容', ...(to === undefined ? {} : { to }) }, exec)
  h.visible = (name, context = exec) => conditions.get(name)({ agent: context.agent })
  return h
}

for (const name of ['qq_send', 'qq_send_voice']) {
  for (const scope of ['private', 'group']) {
    test(`${name}：${scope} 普通账号可发当前聊天，显式当前目标不要求授权身份`, async t => {
      const h = fixture(t, { scope, extra: { ownerIds: [] } })
      for (const to of [undefined, `${scope === 'group' ? 'group' : 'user'}:10001`]) {
        assert.equal((await h.send(name, to)).ok, true)
      }
      assert.equal(h.calls.length, 2)
      assert.ok(h.calls.every(call => call.action === `send_${scope}_msg` && call.params[scope === 'group' ? 'group_id' : 'user_id'] === 10001))
      assert.equal(h.source.lastSentMessageId, 71)
      assert.ok(h.notes.every(([record]) => record === h.source))
    })
  }

  test(`${name}：普通账号和群内授权账号均不能跨聊天发送，拒绝前不合成或外发`, async t => {
    for (const [scope, ownerIds] of [['private', []], ['group', ['10001']]]) {
      const h = fixture(t, { scope, extra: { ownerIds } })
      for (const to of ['group:70001', 'user:10002']) await assert.rejects(h.send(name, to), /授权账号私聊/)
      assert.equal(h.calls.length, 0)
      assert.equal(h.synthesis.length, 0)
      assert.equal(h.notes.length, 0)
    }
  })

  test(`${name}：授权私聊向其他群或私聊发送，只更新目标记录`, async t => {
    const h = fixture(t)
    for (const [to, record] of [['group:70001', h.group], ['user:10002', h.privateChat]]) {
      assert.equal((await h.send(name, to)).ok, true)
      assert.equal(h.notes.at(-1)[0], record)
      assert.equal(h.memories.at(-1)[0], record)
      assert.equal(h.memories.at(-1)[2], 71)
      assert.equal(h.activity.at(-1), record)
      assert.equal(record.lastSentMessageId, 71)
    }
    assert.equal(h.source.lastSentMessageId, 11)
    assert.ok(h.notes.every(([record]) => record !== h.source))
    assert.equal(h.proactive.length, 0, '跨聊天发送不冒充目标聊天自身的主动轮交付')
  })

  test(`${name}：有符号消息 ID 和零值可确认、记账并作为默认撤回目标`, async t => {
    const h = fixture(t)
    for (const id of [-2147483648, -71, 0, 2147483647]) {
      for (const response of [{ message_id: id }, { data: { message_id: String(id) } }]) {
        h.response = response
        const result = await h.send(name, 'group:70001')
        assert.equal(result.ok, true)
        assert.equal(result.messageId, id)
        assert.equal(h.group.lastSentMessageId, id)
        assert.equal(h.memories.at(-1)[0], h.group)
        assert.equal(h.memories.at(-1)[2], id)
        h.quoted = { group_id: 70001, sender: { user_id: 90001 }, message_id: id }
        const recalled = await h.tools.get('qq_recall').execute({}, { agent: { session: { id: 'group' } } })
        assert.equal(recalled.ok, true)
        assert.deepEqual(h.calls.at(-1), { action: 'delete_msg', params: { message_id: id } })
      }
    }
    assert.equal(h.source.lastSentMessageId, 11)
    assert.ok(h.notes.every(([record]) => record === h.group))
  })

  test(`${name}：当前或目标聊天关闭、名单不符、账号身份变化均不发送`, async t => {
    for (const config of [
      { privateMode: 'disabled' }, { replyToPrivate: false }, { privateMode: 'allowlist', privateAllow: [] },
      { groupMode: 'disabled' }, { groupMode: 'allowlist', groupAllow: [] },
      { peerBots: ['10001'], botChatEnabled: false },
    ]) {
      const h = fixture(t, { extra: config })
      await assert.rejects(h.send(name, 'group:70001'), /未获准/)
      assert.equal(h.calls.length, 0)
      assert.equal(h.synthesis.length, 0)
    }
    const h = fixture(t)
    h.manager.selfId = '90002'
    await assert.rejects(h.send(name, 'group:70001'), /未获准/)
    h.manager.selfId = '90001'
    h.config.peerBots = ['10002']
    await assert.rejects(h.send(name, 'user:10002'), /未获准/)
    assert.equal(h.calls.length, 0)
    assert.equal(h.synthesis.length, 0)
  })

  test(`${name}：非法目标在合成和外发前被拒绝`, async t => {
    const h = fixture(t)
    for (const to of ['group:0', 'user:-1', 'group:9007199254740993', 'other:10001', {}, null]) {
      await assert.rejects(h.send(name, to), /to 格式/)
    }
    assert.equal(h.calls.length, 0)
    assert.equal(h.synthesis.length, 0)
  })

  test(`${name}：内容检查期间撤销授权，准备下一阶段前重新检查`, async t => {
    const h = fixture(t)
    const sending = h.send(name, 'group:70001')
    h.config.ownerIds = []
    await assert.rejects(sending, /授权账号私聊/)
    assert.equal(h.synthesis.length, 0)
    assert.equal(h.calls.length, 0)
    assert.equal(h.notes.length, 0)
  })

  test(`${name}：冷目标发送不创建 Agent，也不污染发起聊天的历史或撤回目标`, async t => {
    const h = fixture(t)
    h.manager.findByPeer = () => null
    h.manager.obtain = () => assert.fail('不能为发送记账启动 Agent')
    assert.equal((await h.send(name, 'group:70001')).ok, true)
    assert.equal(h.calls.length, 1)
    assert.equal(h.notes.length, 0)
    assert.equal(h.memories.length, 0)
    assert.equal(h.source.lastSentMessageId, 11)
  })

  test(`${name}：失败或缺少消息 ID 不写成功记录，不自动重试`, async t => {
    const h = fixture(t)
    const responses = [{}, ...[null, '', ' ', false, true, 1.5, Number.MAX_SAFE_INTEGER + 1].map(message_id => ({ message_id })), new Error('模拟回执丢失')]
    for (const response of responses) {
      h.response = response
      await assert.rejects(h.send(name, 'group:70001'), /未确认/)
    }
    assert.equal(h.calls.length, responses.length)
    assert.equal(h.notes.length, 0)
    assert.equal(h.memories.length, 0)
    assert.equal(h.source.lastSentMessageId, 11)
    assert.equal(h.group.lastSentMessageId, 22)
  })
}

test('默认撤回缺少消息 ID 时不调用协议端', async t => {
  const h = fixture(t)
  delete h.source.lastSentMessageId
  await assert.rejects(h.tools.get('qq_recall').execute({}, exec), /找不到要撤回的消息/)
  assert.equal(h.calls.length, 0)
})

test('语音合成期间撤销授权或关闭目标，发送前再次检查，不外发或记成功', async t => {
  for (const revoke of [h => { h.config.ownerIds = [] }, h => { h.config.groupMode = 'disabled' }, h => { h.config.privateMode = 'disabled' }]) {
    const h = fixture(t)
    h.beforeSynthesis = () => revoke(h)
    await assert.rejects(h.send('qq_send_voice', 'group:70001'), /授权账号私聊|未获准/)
    assert.equal(h.synthesis.length, 1)
    assert.equal(h.calls.length, 0)
    assert.equal(h.notes.length, 0)
  }
})

test('语音合成中关闭功能，发送前拒绝，不记成功', async t => {
  const h = fixture(t)
  h.beforeSynthesis = () => { h.config.voiceEnabled = false }
  await assert.rejects(h.send('qq_send_voice'), /不可用/)
  assert.equal(h.synthesis.length, 1)
  assert.equal(h.calls.length, 0)
  assert.equal(h.notes.length, 0)
})

test('文字引用已并入 qq_send：按目标核对引用、普通发送不默认引用', async t => {
  const h = fixture(t)
  assert.equal(h.tools.has('qq_reply'), false)
  for (const [to, quoted] of [
    ['group:70001', { message_id: -19, message_type: 'group', group_id: 70001 }],
    ['user:10002', { message_id: -19, message_type: 'private', sender: { user_id: 10002 } }],
  ]) {
    h.quoted = quoted
    const result = await h.tools.get('qq_send').execute({ text: '引用回复', to, message_id: -19 }, exec)
    assert.equal(result.ok, true)
    assert.deepEqual(h.calls.at(-1).params.message, [
      { type: 'reply', data: { id: '-19' } }, { type: 'text', data: { text: '引用回复' } },
    ])
  }
  h.source.lastMessageId = 999
  await h.send('qq_send')
  assert.equal(h.calls.at(-1).params.message.some(segment => segment.type === 'reply'), false)
})

test('引用跨聊天消息、缺少归属或无效 ID 时，不发送也不记账', async t => {
  const h = fixture(t)
  for (const [to, quoted] of [
    ['group:70001', { group_id: 70002 }], ['group:70001', {}],
    ['user:10002', { message_type: 'private', sender: { user_id: 10001 } }],
    ['user:10002', { message_type: 'group', group_id: 70001, user_id: 10002 }],
  ]) {
    h.quoted = quoted
    await assert.rejects(h.tools.get('qq_send').execute({ text: '不能引用', to, message_id: 7 }, exec), /归属|不属于/)
  }
  await assert.rejects(h.tools.get('qq_send').execute({ text: '无效引用', message_id: null }, exec), /有效整数/)
  assert.ok(h.calls.every(call => call.action === 'get_msg'))
  assert.equal(h.notes.length, 0)
})

test('核实引用期间撤销授权，不能继续跨聊天发送', async t => {
  const h = fixture(t)
  h.quoted = { group_id: 70001 }
  h.beforeReply = () => { h.config.ownerIds = [] }
  await assert.rejects(h.tools.get('qq_send').execute({ text: '不能发送', to: 'group:70001', message_id: 7 }, exec), /授权账号私聊/)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].action, 'get_msg')
})

test('分组默认值、平台和资料路径同时用于提供条件与执行检查', async t => {
  const h = fixture(t, { extra: { voiceEnabled: false } })
  for (const name of ['qq_face', 'qq_poke', 'qq_react', 'qq_like', 'qq_faces', 'qq_mface', 'qq_keep_face', 'qq_send']) assert.equal(h.visible(name), true, name)
  for (const name of ['qq_send_voice', 'qq_qzone_send', 'qq_search']) assert.equal(h.visible(name), false, name)
  h.config.voiceEnabled = true
  assert.equal(h.visible('qq_send_voice'), true)
  const other = fixture(t, { platform: 'linux' })
  assert.equal(other.visible('qq_send_voice'), false)
  await assert.rejects(other.send('qq_send_voice'), /不可用/)
  assert.equal(other.synthesis.length, 0)
  h.config.qzoneEnabled = true
  assert.equal(h.visible('qq_qzone_send'), true)
  assert.equal(h.visible('qq_qzone_send', { agent: { session: { id: 'group' } } }), false)
  h.config.qqInteractionEnabled = false
  h.config.stickerEnabled = false
  for (const name of ['qq_face', 'qq_poke', 'qq_react', 'qq_like', 'qq_faces', 'qq_mface']) {
    assert.equal(h.visible(name), false)
    await assert.rejects(h.tools.get(name).execute({}, exec), /不可用/)
  }
  assert.equal(h.visible('qq_keep_face'), true)
  assert.equal(h.visible('qq_send'), true)
  assert.equal(h.tools.has('qq_meme'), false)
  assert.equal(h.tools.has('qq_memo'), false)
  assert.ok([...h.tools.keys()].every(name => !h.visible(name, { agent: { session: { id: 'ordinary' } } })))
  assert.equal(h.calls.length, 0)
})

test('空规则允许明确收藏，阻止自动收藏；关闭表情使用不阻止商城登记或普通收藏', async t => {
  const h = fixture(t, { extra: { stickerEnabled: false } })
  const path = join(h.config.cwd, 'source.png')
  writeFileSync(path, 'mock image')
  const collect = args => h.tools.get('qq_keep_face').execute({ path, ...args }, exec)
  await assert.rejects(collect({ mode: 'automatic' }), /未设置/)
  await assert.rejects(collect({}), /收藏来源/)
  const result = await collect({ mode: 'requested', summary: '明确收藏' })
  assert.equal(result.ok, true)
  const image = listFaces(h.config).find(item => item.kind === 'image')
  assert.ok(image)
  rmSync(path)
  assert.equal(existsSync(image.path), true, '收藏保存独立副本，不依赖缓存原文件')
  assert.equal(readFileSync(image.path, 'utf8'), 'mock image')
  const mface = [{ emojiId: '100', packageId: '200', summary: '商城表情' }]
  assert.equal(rememberFaces(h.config, mface), 1)
  assert.equal(rememberFaces(h.config, mface), 0)
  writeFileSync(path, 'another mock image')
  h.config.faceCollectHint = '猫猫梗图'
  assert.equal((await collect({ mode: 'automatic', summary: '猫猫' })).ok, true)
  assert.match(faceCollectRule(h.config), /猫猫梗图/)
  h.config.faceCollectHint = ''
  assert.match(faceCollectRule(h.config), /不自动收藏/)
  await assert.rejects(collect({ mode: 'automatic' }), /未设置/)
  assert.equal(h.calls.length, 0, '收藏与登记不触发外发')
})

test('表情直发等待期间关闭使用，不再进入 CDN 发送路径', async t => {
  const h = fixture(t)
  h.response = new Error('模拟协议拒绝')
  h.beforeReply = () => { h.config.stickerEnabled = false }
  await assert.rejects(h.tools.get('qq_mface').execute({ emoji_id: '100', emoji_package_id: '200' }, exec), /未确认/)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].params.message[0].type, 'mface')
  assert.equal(h.notes.length, 0)
})

test('空间发布排队期间关闭开关，不发布也不预留次数', async t => {
  const h = fixture(t, { extra: { qzoneEnabled: true } })
  const pending = h.tools.get('qq_qzone_send').execute({ text: '测试文案' }, exec)
  h.config.qzoneEnabled = false
  await assert.rejects(pending, /不可用/)
  assert.equal(h.calls.length, 0)
  assert.equal(existsSync(join(h.config.cwd, 'qzone-state.json')), false)
})

test('工具说明区分资料检索与记忆，并明确语音平台限制', t => {
  const h = fixture(t)
  assert.match(h.tools.get('qq_search').description, /来源|记忆/)
  assert.match(h.tools.get('qq_send_voice').description, /仅 Windows|其他平台/)
})

for (const name of ['qq_send', 'qq_send_voice', 'qq_send_image', 'qq_face', 'qq_mface', 'qq_poke', 'qq_react', 'qq_like', 'qq_recall', 'qq_send_file']) {
  test(`${name}：拒绝、未发送、超时均走失败通道，不隐式重试或记成功`, async t => {
    const h = fixture(t)
    Object.assign(h.source, { lastSenderId: '10001', lastMessageId: 7 })
    const args = { qq_send: { text: '测试' }, qq_send_voice: { text: '测试' }, qq_send_image: { file: 'test.png' },
      qq_face: { id: '1' }, qq_mface: { emoji_id: '100', emoji_package_id: '200' }, qq_poke: {},
      qq_react: { emoji_id: '1' }, qq_like: {}, qq_recall: {}, qq_send_file: { file: 'test.txt' } }[name]
    for (const [delivery, expected] of [['rejected', /协议拒绝/], ['not-sent', /未发送/], [undefined, /未确认/]]) {
      h.response = Object.assign(new Error('private diagnosis'), delivery ? { onebotDelivery: delivery } : {})
      await assert.rejects(h.tools.get(name).execute(args, exec), expected)
    }
    assert.equal(h.calls.filter(call => call.action !== 'get_msg').length, 3)
    assert.equal(h.notes.length, 0)
    assert.equal(h.source.lastSentMessageId, 11)
  })
}

for (const name of ['qq_send_image', 'qq_face', 'qq_mface']) {
  test(`${name}：消息ID缺失不冒充失败，合法负数和零值均确认并记账`, async t => {
    const h = fixture(t)
    const args = name === 'qq_send_image' ? { file: 'test.png' } : name === 'qq_face' ? { id: '1' } : { emoji_id: '100', emoji_package_id: '200' }
    h.response = {}
    await assert.rejects(h.tools.get(name).execute(args, exec), /未确认/)
    assert.equal(h.notes.length, 0)
    for (const id of [-71, 0]) {
      h.response = { message_id: id }
      assert.equal((await h.tools.get(name).execute(args, exec)).ok, true)
      assert.equal(h.source.lastSentMessageId, id)
      assert.equal(h.memories.at(-1)[2], id)
    }
    assert.equal(h.calls.length, 3)
  })
}

test('表情收藏分页包含真实总数、无名称数和续读位置；改动后拒绝旧页', async t => {
  const h = fixture(t)
  const input = Array.from({ length: 125 }, (_, n) => ({ emojiId: String(n + 1), packageId: '200', summary: n === 124 ? '' : '名称' + n }))
  rememberFaces(h.config, input)
  const tool = h.tools.get('qq_faces')
  const names = []
  let args = {}, first
  do {
    const page = await tool.execute(args, exec)
    assert.ok(JSON.stringify(page).length <= 12000)
    assert.equal(page.total, 125)
    assert.equal(page.unnamed, 1)
    assert.equal(page.matched, 124)
    names.push(...page.names)
    first ??= page
    args = page.next
  } while (args)
  assert.deepEqual(names, input.slice(0, 124).map(f => f.summary))
  assert.equal((await tool.execute({ keyword: '不存在' }, exec)).ok, true)
  rememberFaces(h.config, [{ emojiId: '999', packageId: '200', summary: '新增' }])
  await assert.rejects(tool.execute(first.next, exec), /STALE_PAGE/)
})

test('超长收藏名称按完整JSON预算续读，不丢失转义字符或emoji', async t => {
  const h = fixture(t)
  const summary = '\n"\\😀'.repeat(5000)
  rememberFaces(h.config, [{ emojiId: '1', packageId: '200', summary }])
  const tool = h.tools.get('qq_faces')
  let args = {}, rebuilt = ''
  do {
    const result = await tool.execute(args, exec)
    assert.ok(JSON.stringify(result).length <= 12000)
    rebuilt += result.names.join('')
    args = result.next
  } while (args)
  assert.equal(rebuilt, summary.trim())
})

test('空收藏是正常查询，收藏失败走失败通道，取图空结果与查询失败可区分', async t => {
  const h = fixture(t)
  assert.equal((await h.tools.get('qq_faces').execute({}, exec)).ok, true)
  await assert.rejects(h.tools.get('qq_keep_face').execute({ path: join(h.config.cwd, 'missing.png'), mode: 'requested' }, exec), /不存在/)
  h.source.lastMessageId = 7
  h.quoted = { message_type: 'private', sender: { user_id: 10001 }, message: [] }
  const empty = await h.tools.get('qq_images').execute({}, exec)
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.paths, [])
  h.beforeReply = () => { throw new Error('private diagnosis') }
  await assert.rejects(h.tools.get('qq_images').execute({}, exec), /取消息失败/)
})

test('历史取图不把无效回执当空消息，有符号ID可取图和表态', async t => {
  const h = fixture(t)
  for (const message_id of [-71, 0]) {
    h.quoted = { message_type: 'private', sender: { user_id: 10001 } }
    await assert.rejects(h.tools.get('qq_images').execute({ message_id }, exec), /缺少正文/)
    h.quoted = { message_type: 'private', sender: { user_id: 10001 }, message: '' }
    assert.equal((await h.tools.get('qq_images').execute({ message_id }, exec)).ok, true)
    assert.equal((await h.tools.get('qq_react').execute({ message_id, emoji_id: '1' }, exec)).messageId, message_id)
  }
})

for (const [name, args] of [['qq_images', { message_id: 71 }], ['qq_react', { message_id: 71, emoji_id: '1' }], ['qq_recall', { message_id: 71 }]]) {
  test(`${name} 拒绝跨聊天、无法确认归属、矛盾回执和异步查询期间撤权`, async t => {
    for (const scope of ['private', 'group']) {
      const h = fixture(t, { scope })
      const wrong = scope === 'group' ? { group_id: 70002 } : { message_type: 'private', sender: { user_id: 11009 } }
      for (const reply of [{}, wrong, { message_id: 72, group_id: 10001 }]) {
        h.quoted = { ...reply, message: [] }
        await assert.rejects(h.tools.get(name).execute(args, exec), /归属|不属于|回执无效/)
        assert.ok(h.calls.every(call => call.action === 'get_msg'), '校验失败不表态、撤回或下载图片')
      }
      h.manager.messageStore = { hasMessage: () => true }
      h.quoted = { ...wrong, message: [] }
      await assert.rejects(h.tools.get(name).execute(args, exec), /不属于/)
      h.quoted = { message_type: scope, ...(scope === 'group' ? { group_id: 10001 } : {}),
        sender: { user_id: 10001 }, message: [] }
      h.beforeReply = () => { h.config[scope === 'group' ? 'groupMode' : 'privateMode'] = 'disabled' }
      await assert.rejects(h.tools.get(name).execute(args, exec), /未获准/)
      assert.ok(h.calls.every(call => call.action === 'get_msg'))
    }
  })
}

test('撤回必须有机器人发送身份，本地归属记录不能替别人撤回；私聊已确认发送可凭记录定位', async t => {
  const h = fixture(t)
  h.manager.messageStore = { hasMessage: (_record, id) => id === 71 }
  h.quoted = { message_type: 'private', sender: { user_id: 10001 } }
  await assert.rejects(h.tools.get('qq_recall').execute({ message_id: 71 }, exec), /机器人自己/)
  h.quoted = { message_type: 'private', sender: { user_id: 90001 } }
  assert.equal((await h.tools.get('qq_recall').execute({ message_id: 71 }, exec)).ok, true)
  await assert.rejects(h.tools.get('qq_recall').execute({ message_id: 72 }, exec), /无法确认/)
})
