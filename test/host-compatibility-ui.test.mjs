import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

async function dialog() {
  const state = [], dependencies = [], effects = [], listeners = new Map(), calls = []
  const current = { verifiedVersion: '0.2.2-rc.2', pending: true, versions: { 'dsh-agent-loop': '0.2.3-rc.1' } }
  let cursor = 0, effectCursor = 0, bundle, Dialog, fail = false
  const React = {
    createElement: (type, props) => ({ type, props }),
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useEffect(fn, deps) {
      const index = effectCursor++
      if (!dependencies[index] || deps.some((value, i) => value !== dependencies[index][i])) {
        dependencies[index] = deps
        effects.push(fn)
      }
    },
  }
  const window = { __ModuleLoader__: { load(value) { bundle = value } },
    addEventListener(name, fn) { listeners.set(name, fn) }, removeEventListener(name) { listeners.delete(name) } }
  const context = vm.createContext({ window, setInterval() { return 1 }, clearInterval() {},
    document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } },
    fetch: async (url, options) => {
      if (options?.method === 'POST') {
        calls.push(JSON.parse(options.body))
        if (fail) return { ok: false, status: 409, text: async () => '版本已变化' }
        current.pending = false; current.accepted = true
      }
      return { ok: true, json: async () => ({ compatibility: current }) }
    },
  })
  vm.runInContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context)
  bundle.factory(name => name === 'react' ? React : { RiskConfirmation: 'official-risk-dialog' }).apply({
    effect() {}, slots: { inject: (_name, fn) => fn(), register(meta, component) { if (meta.name === 'shell.overlay') Dialog = component } },
  })
  const render = () => {
    cursor = 0; effectCursor = 0
    const result = Dialog()
    for (const effect of effects.splice(0)) effect()
    return result.props
  }
  render()
  await new Promise(resolve => setImmediate(resolve))
  render()
  return { render, current, calls, state, listeners, set fail(value) { fail = value } }
}

test('全局风险弹窗默认未勾选，取消不放行，可从设置重新打开，明确确认才请求', async () => {
  const h = await dialog()
  assert.equal(h.render().open, true)
  assert.equal(h.render().acknowledged, false)
  await h.render().onConfirm()
  assert.equal(h.calls.length, 0)
  h.render().onCancel()
  assert.equal(h.render().open, false)
  assert.equal(h.current.pending, true)
  h.listeners.get('dsh-qq:show-compatibility')()
  assert.equal(h.render().open, true)
  h.render().onAcknowledgedChange(true)
  await h.render().onConfirm()
  assert.equal(h.calls.length, 1)
  assert.equal(JSON.stringify(h.calls[0].versions), JSON.stringify(h.current.versions))
  assert.equal(h.render().open, false)
})

test('版本变化清除上次勾选；保存失败保留弹窗并显示错误', async () => {
  const h = await dialog()
  h.render().onAcknowledgedChange(true)
  h.current.versions = { 'dsh-agent-loop': '0.2.4-rc.1' }
  h.render()
  assert.equal(h.render().acknowledged, false)
  h.fail = true
  h.render().onAcknowledgedChange(true)
  await h.render().onConfirm()
  assert.equal(h.render().open, true)
  assert.match(h.render().description, /版本已变化/)
})
