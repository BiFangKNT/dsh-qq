// 只补齐正式 client.js 使用的宿主加载器和设置槽；组件及 API 均复用正式实现。
const settingsRoot = document.getElementById('settings-root')
const cleanups = []
let root

window.__ModuleLoader__ = {
  load(bundle) {
    try {
      const plugin = bundle.factory(name => {
        if (name === 'react') return window.React
        throw new Error(`设置预览未提供模块：${name}`)
      })
      plugin.apply({
        effect(setup) {
          const dispose = setup()
          if (typeof dispose === 'function') cleanups.push(dispose)
        },
        slots: {
          inject(name, setup) {
            if (name !== 'settings.section') throw new Error(`设置预览未提供槽：${name}`)
            return setup()
          },
          register(_meta, render) {
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
  for (const dispose of cleanups.reverse()) dispose()
})
