import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

async function panel({ beforeSave } = {}) {
  const pending = [{ sessionId: 'a', label: '测试私聊' }, { sessionId: 'b', label: '测试群' }]
  const status = { promptSync: { pending, operations: [] } }
  const values = { persona: '当前人设' }
  const calls = [], state = [status, '34569', values]
  let cursor = 0, bundle, renderPanel
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const i = cursor++
      if (!(i in state)) state[i] = initial
      return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
    },
    useCallback: fn => fn,
    useRef(initial) {
      const i = cursor++
      if (!(i in state)) state[i] = { current: initial }
      return state[i]
    },
    useEffect() {},
  }
  const fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null
    calls.push({ url, body })
    let result = status
    if (url.endsWith('/prompt-sync')) result = { ok: true }
    else if (url.endsWith('/settings')) {
      if (body?.patch) {
        await beforeSave?.(body.patch)
        Object.assign(values, body.patch)
      }
      result = { values: structuredClone(values), promptSync: status.promptSync, systemChanged: false }
    }
    return { ok: true, json: async () => result }
  }
  const context = vm.createContext({ window: { __ModuleLoader__: { load: value => { bundle = value } } },
    fetch, setTimeout, setInterval, clearInterval,
    document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } } })
  vm.runInContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context)
  bundle.factory(() => React).apply({ effect() {}, slots: {
    inject: (_slot, fn) => fn(), register: (meta, render) => { if (meta.name === 'settings.section') renderPanel = render },
  } })
  const Panel = renderPanel().type
  const flatten = element => !element || typeof element !== 'object' ? [] :
    [element, ...element.children.flat(Infinity).flatMap(flatten)]
  const render = () => { cursor = 0; return flatten(Panel()) }
  return { render, calls, state, status }
}
const button = (tree, text) => tree.find(element => element.type === 'button' && element.children.includes(text))

test('设置页显示四个选择，可选择会话；稍后同步保留待同步入口', async () => {
  const h = await panel()
  let tree = h.render()
  assert.ok(button(tree, '创建新会话'))
  assert.ok(button(tree, '压缩会话'))
  assert.ok(button(tree, '强制同步'))
  button(tree, '稍后同步').props.onClick()
  tree = h.render()
  assert.equal(button(tree, '创建新会话'), undefined)
  button(tree, '选择同步方式（2 个会话）').props.onClick()
  tree = h.render()
  tree.find(element => element.type === 'input' && element.props.type === 'checkbox').props.onChange({ target: { checked: false } })
  await button(h.render(), '压缩会话').props.onClick()
  assert.deepEqual(h.calls.find(call => call.url.endsWith('/prompt-sync')).body,
    { action: 'compact', sessionIds: ['b'] })
})

test('强制同步位于稍后同步前，解释缓存影响且只提交所选会话', async () => {
  const h = await panel(), tree = h.render()
  const force = button(tree, '强制同步')
  assert.ok(tree.indexOf(force) < tree.indexOf(button(tree, '稍后同步')))
  assert.match(force.props.title, /保留当前会话和完整历史/)
  assert.match(force.props.title, /缓存命中率/)
  tree.find(element => element.type === 'input' && element.props.type === 'checkbox').props.onChange({ target: { checked: false } })
  await button(h.render(), '强制同步').props.onClick()
  assert.deepEqual(h.calls.find(call => call.url.endsWith('/prompt-sync')).body,
    { action: 'force', sessionIds: ['b'] })
  h.status.promptSync.operations = [{ id: 'op', status: 'running', sessions: [] }]
  assert.equal(button(h.render(), '强制同步').props.disabled, true)
  h.status.promptSync.operations = []
  h.render().filter(element => element.type === 'input' && element.props.type === 'checkbox')
    .forEach(element => element.props.onChange({ target: { checked: false } }))
  assert.equal(button(h.render(), '强制同步').props.disabled, true)
})

test('普通保存不重复弹出已推迟的提示，执行中的操作禁用重复同步', async () => {
  const h = await panel()
  button(h.render(), '稍后同步').props.onClick()
  const area = h.render().find(element => element.type === 'textarea' && element.props.value === '当前人设')
  await area.props.onBlur({ target: { value: '保存后实际规则未改变' } })
  assert.equal(button(h.render(), '创建新会话'), undefined)
  button(h.render(), '选择同步方式（2 个会话）').props.onClick()
  h.status.promptSync.operations = [{ id: 'op', status: 'running', sessions: [] }]
  assert.equal(button(h.render(), '创建新会话').props.disabled, true)
})

test('设置页提供 Agent 工具预设，保存 preset 并说明新会话生效', async () => {
  const h = await panel(), tree = h.render()
  const label = tree.find(element => element.children.includes('Agent 工具预设'))
  assert.ok(label)
  assert.match(JSON.stringify(tree), /新会话生效/)
  assert.match(JSON.stringify(tree), /宿主默认预设/)
  const input = tree.slice(tree.indexOf(label)).find(element => element.type === 'input')
  input.props.onBlur({ target: { value: 'images' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls.find(call => call.url.endsWith('/settings')).body, { patch: { preset: 'images' } })
})

test('设置页可保存多个触发词并清空', async () => {
  const h = await panel()
  h.state[2].groupTriggerWords = ['小助手']
  const tree = h.render()
  const label = tree.find(element => element.children.includes('立即处理的触发词'))
  assert.ok(label)
  const input = tree.slice(tree.indexOf(label)).find(element => element.type === 'input')
  input.props.onBlur({ target: { value: '小助手,来看看' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls.find(call => call.url.endsWith('/settings')).body,
    { patch: { groupTriggerWords: ['小助手', '来看看'] } })
  input.props.onBlur({ target: { value: '' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls.filter(call => call.url.endsWith('/settings')).at(-1).body,
    { patch: { groupTriggerWords: [] } })
})

test('设置页按账号编辑、添加和移除称呼，不连带修改授权名单', async () => {
  const h = await panel()
  h.state[2].memberLabels = { '10001': '爸爸', '10002': '小林' }
  const byLabel = (tree, label) => tree.find(element => element.props['aria-label'] === label)
  assert.ok(h.render().some(element => element.children.includes('授权账号（QQ 号）')))
  assert.equal(h.render().some(element => element.children.includes('在群里怎么称呼主人')), false)
  byLabel(h.render(), '账号 10002 的称呼').props.onBlur({ target: { value: '阿林' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls.filter(call => call.url.endsWith('/settings')).at(-1).body,
    { patch: { memberLabels: { '10001': '爸爸', '10002': '阿林' } } })
  byLabel(h.render(), '称呼对应的 QQ 号').props.onChange({ target: { value: '10003' } })
  byLabel(h.render(), '新成员称呼').props.onChange({ target: { value: '小周' } })
  await button(h.render(), '添加称呼').props.onClick()
  assert.deepEqual(h.calls.filter(call => call.url.endsWith('/settings')).at(-1).body,
    { patch: { memberLabels: { '10001': '爸爸', '10002': '阿林', '10003': '小周' } } })
  button(h.render(), '移除').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls.filter(call => call.url.endsWith('/settings')).at(-1).body,
    { patch: { memberLabels: { '10002': '阿林', '10003': '小周' } } })
})

for (const action of ['移除', '编辑']) {
  test(`称呼保存未返回时${action}另一成员，按顺序保留全部修改`, async () => {
    const first = Promise.withResolvers()
    let saves = 0
    const h = await panel({ beforeSave: () => ++saves === 1 ? first.promise : undefined })
    h.state[2].memberLabels = { '10001': '原称呼', '10002': '小林' }
    const tree = h.render()
    const input = id => tree.find(element => element.props['aria-label'] === `账号 ${id} 的称呼`)
    const edited = input('10001').props.onBlur({ target: { value: '新称呼' } })
    // blur 与 click 可以使用同一份渲染结果，不能依赖 React 先完成重渲染。
    const next = action === '移除'
      ? tree.filter(element => element.type === 'button' && element.children.includes('移除'))[1].props.onClick()
      : input('10002').props.onBlur({ target: { value: '阿林' } })
    await new Promise(resolve => setImmediate(resolve))
    const requests = () => h.calls.filter(call => call.url.endsWith('/settings'))
    assert.equal(requests().length, 1, '前一笔保存完成前不发送后一笔')
    h.render()
    first.resolve()
    await Promise.all([edited, next])
    const expected = action === '移除' ? { '10001': '新称呼' } : { '10001': '新称呼', '10002': '阿林' }
    assert.equal(requests().length, 2)
    assert.deepEqual(requests()[1].body, { patch: { memberLabels: expected } })
    assert.deepEqual(h.state[2].memberLabels, expected)
  })
}

test('慢保存返回时保留另一成员尚未失焦的称呼草稿', async () => {
  const first = Promise.withResolvers()
  let saves = 0
  const h = await panel({ beforeSave: () => ++saves === 1 ? first.promise : undefined })
  h.state[2].memberLabels = { '10001': '原称呼', '10002': '小林' }
  const input = id => h.render().find(element => element.props['aria-label'] === `账号 ${id} 的称呼`)
  const edited = input('10001').props.onBlur({ target: { value: '新称呼' } })
  await new Promise(resolve => setImmediate(resolve))
  input('10002').props.onChange({ target: { value: '尚未保存的称呼' } })
  first.resolve()
  await edited
  assert.equal(input('10002').props.value, '尚未保存的称呼')
  await input('10002').props.onBlur({ target: { value: '尚未保存的称呼' } })
  assert.deepEqual(h.state[2].memberLabels, { '10001': '新称呼', '10002': '尚未保存的称呼' })
})

test('保存失败不清掉称呼草稿，后续可明确重试保存', async () => {
  let saves = 0
  const h = await panel({ beforeSave: () => { if (++saves === 1) throw new Error('模拟保存失败') } })
  h.state[2].memberLabels = { '10001': '原称呼' }
  const input = () => h.render().find(element => element.props['aria-label'] === '账号 10001 的称呼')
  input().props.onChange({ target: { value: '新称呼' } })
  assert.equal(await input().props.onBlur({ target: { value: '新称呼' } }), false)
  assert.equal(input().props.value, '新称呼')
  assert.equal(h.state[2].memberLabels['10001'], '原称呼')
  assert.equal(await input().props.onBlur({ target: { value: '新称呼' } }), true)
  assert.equal(h.state[2].memberLabels['10001'], '新称呼')
})
