import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

async function panel() {
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
    useEffect() {},
  }
  const fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null
    calls.push({ url, body })
    let result = status
    if (url.endsWith('/prompt-sync')) result = { ok: true }
    else if (url.endsWith('/settings')) result = { values, promptSync: status.promptSync, systemChanged: false }
    return { ok: true, json: async () => result }
  }
  const context = vm.createContext({ window: { __ModuleLoader__: { load: value => { bundle = value } } },
    fetch, setTimeout, setInterval, clearInterval,
    document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } } })
  vm.runInContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context)
  bundle.factory(() => React).apply({ effect() {}, slots: {
    inject: (_slot, fn) => fn(), register: (_meta, render) => { renderPanel = render },
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
