import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import vm from 'node:vm'
import { ensurePeerWorkspace } from '../src/workspace.js'
import { doorLine, doorList, markDoorRead } from '../src/door.js'
import { buildChatPrompt, proactiveRule, readingAskRule } from '../src/prompts.js'
import { createOutbound, stripLeakedThinking, stripClosingTalk } from '../src/outbound.js'
import { isDirectedAtAi, evaluateWakeTrigger } from '../src/wake-trigger.js'
import { installSettingsApi } from '../src/settings.js'
import { waitFor } from './mock-dsh.mjs'

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-portable-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('会话模板保持在会话内，仅在启用共享记忆后提示工具', async t => {
  const root = await temporary(t)
  const info = { scope: 'private', peerId: '11001', label: '测试会话' }
  for (const [name, config] of [['isolated', {}], ['shared', { memoryRoot: join(root, '共享') }]]) {
    const dir = join(root, name)
    await ensurePeerWorkspace(dir, info, config)
    const text = await readFile(join(dir, 'AGENTS.md'), 'utf8')
    assert.doesNotMatch(text, /鲸鲸|姐姐|2710586329|[A-Z]:[\\/]|\.\.\/私人|谁也看不见/)
    assert.match(text, /管理员读取/)
    assert.match(text, /\.\/记忆区\/随笔/)
    assert.equal(/\bqq_memo\b/.test(text), name === 'shared')
  }
})

test('已有用户 AGENTS.md 不再自动追加模板或覆盖自定义内容', async t => {
  const dir = await temporary(t)
  const text = '# 我自己的规则\n\n保留这段文字。\n'
  await writeFile(join(dir, 'AGENTS.md'), text)
  await ensurePeerWorkspace(dir, { scope: 'private', peerId: '11001' }, { memoryRoot: 'shared' })
  assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), text)
})

test('门口来源和回信前缀可配置，切换前缀立即刷新列表且已读逻辑一致', async t => {
  const dir = await temporary(t)
  await writeFile(join(dir, '回复-今天.md'), '默认回信')
  await writeFile(join(dir, '助理-今天.md'), '自定义回信')
  const config = { doorDir: dir }
  assert.deepEqual(doorList(config).map(item => item.name), ['助理-今天.md'])
  config.doorReplyPrefix = '助理-'
  config.doorSenderLabel = '写作会话'
  assert.deepEqual(doorList(config).map(item => item.name), ['回复-今天.md'])
  assert.equal(markDoorRead(config, '助理-今天.md'), false)
  const text = doorLine(config)
  assert.match(text, /来自写作会话/)
  assert.match(text, /助理-哪天.md/)
  assert.doesNotMatch(text, /大姐|老三|姐姐|一个钟头/)
  assert.equal(markDoorRead(config, '回复-今天.md'), true)
  assert.deepEqual(doorList(config), [])
  assert.throws(() => doorList({ ...config, doorReplyPrefix: '../' }), /前缀/)
})

test('通用提示词不强加私人关系或固定账号', () => {
  const config = { ownerLabel: '组长', ownerIds: ['11001'], aiGirls: false }
  const text = [buildChatPrompt(config, { isGroup: true }), proactiveRule(config), readingAskRule(config)].join('\n')
  assert.doesNotMatch(text, /2710586329|姐姐|另一只鲸鲸/)
})

test('自定义称呼用于上下文回显和收尾过滤，正常话不丢失', async () => {
  const config = { ownerLabel: '组长[甲]' }
  assert.equal(stripLeakedThinking('[组长[甲]] 今天忙吗', config), '')
  assert.equal(stripClosingTalk('结束这轮，组长[甲]晚安。', config), '结束这轮，组长[甲]晚安。')
  const sent = []
  const onEvent = createOutbound({ manager: { find: () => ({ scope: 'private' }) }, config,
    logger: {}, send: async (_record, text) => sent.push(text) })
  await onEvent({ id: 'test' }, { type: 'assistant/message', data: { message: { content: [
    { type: 'text', text: '[组长[甲]] 今天忙吗\n今天有空，可以聊聊。' },
  ] } } })
  assert.deepEqual(sent, ['今天有空，可以聊聊。'])
})

test('私人别名不再默认触发提问唤醒，配置后的名字仍有效', () => {
  assert.equal(isDirectedAtAi('鲸鲸强吗'), false)
  assert.equal(isDirectedAtAi('鲸鲸强吗', ['鲸鲸']), true)
  assert.equal(evaluateWakeTrigger({ plainText: '小助手强吗', names: ['小助手'], triggers: { nameMention: false } }), 'question')
  assert.equal(evaluateWakeTrigger({ plainText: '鲸鲸强吗', names: ['小助手'], triggers: { nameMention: false } }), null)
  assert.equal(isDirectedAtAi('deepseek 行不行'), true)
})

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('两个独立设置服务可用不同端口，客户端手动选择后读取对应实例', async t => {
  const root = await temporary(t)
  const ports = [], cleanups = []
  t.after(() => { for (const cleanup of cleanups) cleanup() })
  for (const name of ['first', 'second']) {
    const port = await unusedPort()
    ports.push(port)
    installSettingsApi({
      ctx: { get: key => key === 'dshHomePath' ? () => join(root, name) : undefined,
        effect: setup => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup) } },
      config: { localApiPort: port, wsUrl: name }, logger: {},
    })
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/api/dsh-qq/status`)).ok } catch { return false }
    })
  }
  assert.notEqual(ports[0], ports[1])
  for (let i = 0; i < ports.length; i++) {
    const status = await (await fetch(`http://127.0.0.1:${ports[i]}/api/dsh-qq/status`)).json()
    assert.equal(status.wsUrl, i === 0 ? 'first' : 'second')
    const invalid = await fetch(`http://127.0.0.1:${ports[i]}/api/dsh-qq/settings`, {
      method: 'POST', body: JSON.stringify({ patch: { localApiPort: -1 } }),
    })
    assert.equal(invalid.status, 400)
  }
  let bundle, renderPanel, state = [], cursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] },
    useCallback: fn => fn, useEffect() {},
  }
  const context = vm.createContext({ window: { __ModuleLoader__: { load: value => { bundle = value } } },
    fetch, console, setTimeout, setInterval, clearInterval,
    document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } } })
  vm.runInContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context)
  bundle.factory(() => React).apply({ effect() {}, slots: { inject: (_name, fn) => fn(), register: (meta, render) => { if (meta.name === 'settings.section') renderPanel = render } } })
  const Panel = renderPanel().type
  const render = () => { cursor = 0; return Panel() }
  const flatten = element => !element || typeof element !== 'object' ? [] : [element, ...element.children.flat(Infinity).flatMap(flatten)]
  for (let i = 0; i < ports.length; i++) {
    let tree = flatten(render())
    tree.find(el => el.props.id === 'qq-local-api-port').props.onChange({ target: { value: String(ports[i]) } })
    tree = flatten(render())
    tree.find(el => el.type === 'button' && el.children.includes('连接此端口')).props.onClick()
    await waitFor(() => state[0]?.wsUrl === (i === 0 ? 'first' : 'second'))
    assert.equal(state[2].localApiPort, ports[i])
  }
})

test('关闭独立设置服务时仍注册宿主路由，不创建监听器', async t => {
  const root = await temporary(t)
  const routes = [], logs = [], cleanups = []
  t.after(() => cleanups.forEach(fn => fn()))
  const mounted = installSettingsApi({ ctx: { get: () => () => root,
    effect: setup => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup) } },
    webServer: { register: route => { routes.push(route); return () => {} } },
    config: { localApiPort: 0 }, logger: { info: message => logs.push(message) } })
  assert.equal(mounted, true)
  assert.equal(routes.length, 1)
  assert.equal(logs.length, 0)
  assert.equal(cleanups.length, 1)
})
