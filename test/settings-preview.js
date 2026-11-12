// 只补齐正式 client.js 使用的宿主加载器和设置槽；组件及 API 均复用正式实现。
const settingsRoot = document.getElementById('settings-root')
const cleanups = []
let root
let overlayRoot

window.__ModuleLoader__ = {
  load(bundle) {
    try {
      const plugin = bundle.factory(name => {
        if (name === 'react') return window.React
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
          RiskConfirmation: props => {
            if (!props.open) return null
            const h = window.React.createElement
            return h('div', { role: 'dialog', 'aria-modal': true, 'aria-label': props.title,
              style: { position: 'fixed', inset: 0, zIndex: 1000, background: '#0009', display: 'grid', placeItems: 'center' } },
            h('div', { style: { padding: 24, maxWidth: 520, background: 'var(--dsw-alias-bg-overlay)', borderRadius: 12 } },
              h('h2', null, props.title), h('p', null, props.description),
              h('label', null, h('input', { type: 'checkbox', checked: props.acknowledged, disabled: props.disabled,
                onChange: e => props.onAcknowledgedChange(e.target.checked) }), props.acknowledgeLabel),
              h('p', null, h('button', { onClick: props.onCancel }, props.cancelLabel), ' ',
                h('button', { disabled: props.disabled || !props.acknowledged, onClick: props.onConfirm }, props.confirmLabel))))
          },
        }
        throw new Error(`设置预览未提供模块：${name}`)
      })
      plugin.apply({
        effect(setup) {
          const dispose = setup()
          if (typeof dispose === 'function') cleanups.push(dispose)
        },
        slots: {
          inject(name, setup) {
            if (!['settings.section', 'shell.overlay'].includes(name)) throw new Error(`设置预览未提供槽：${name}`)
            return setup()
          },
          register(meta, render) {
            if (meta.name === 'shell.overlay') {
              const container = document.createElement('div'); document.body.appendChild(container)
              overlayRoot = window.ReactDOM.createRoot(container)
              overlayRoot.render(window.React.createElement(render))
              cleanups.push(() => container.remove())
              return
            }
            root = window.ReactDOM.createRoot(settingsRoot)
            root.render(render())
          },
        },
      })
    } catch (err) {
      settingsRoot.textContent = `设置页加载失败：${err.message}`
      console.error(err)
    }
  },
}

const themeButton = document.getElementById('theme')
themeButton.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  themeButton.textContent = dark ? '切换浅色' : '切换深色'
  themeButton.setAttribute('aria-pressed', String(dark))
})
window.addEventListener('pagehide', event => {
  if (event.persisted) return
  root?.unmount()
  overlayRoot?.unmount()
  for (const dispose of cleanups.reverse()) dispose()
})
