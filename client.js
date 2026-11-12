/**
 * dsh-qq —— 浏览器半端（**「设置」里的一页**）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本（DSH 的约定，抄 dsh-bili-scroll）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                    // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⭐ 怎么进「设置」：往 `settings.section` 槽里注册一节，
 *    第一个参数的 `label` 就是设置页左侧导航里那一项。
 *
 * ⭐ 数据都走 `/api/dsh-qq/*`（后端在 src/index.js 里注册）：
 *    后端把改动写进 `$DSH_HOME/dsh-qq/settings.json`（**不动 profile 的 cordis.patch.yml**），
 *    并就地改运行中的 config，所以大部分项保存即生效。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  // ⚠️ 这里的 id 必须等于 package.json 的 name（浏览器模块身份 = manifest 包名）。
  // 1.0.0 起包名从 dsh-qq 改成 dsh-qq-onebot，这里漏改，0.2.x 上整条 client row
  // 就对不上、设置页不出现。别再手滑。
  id: 'dsh-qq-onebot',
  factory: (require) => {
    const React = require('react')
    const { RiskConfirmation } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    // 数据来源两条路（自动选第一个通的）：
    //   1) DSH 自己的 /api/dsh-qq —— 宿主 webServer 愿意把路由挂出来时用这条
    //   2) 插件自己在 127.0.0.1:34569 起的小服务 —— 2026-10-24 加的兜底：
    //      DSH 那边的路由表会「注册成功但请求 404」，实测绕不过去，
    //      所以插件自己做一块本地工作台（这也是官方教程里说的插件形态）。
    const API = '/api/dsh-qq'
    let localPort = 34569
    let localSelected = false
    const localApi = () => 'http://127.0.0.1:' + localPort + '/api/dsh-qq'
    let apiBase = null

    const resolveBase = async () => {
      if (apiBase) return apiBase
      const probe = async (base) => {
        try {
          const r = await fetch(base + '/status', { credentials: 'same-origin' })
          return r.ok ? base : null
        } catch {
          return null // 网络错 / 跨域 / 没起来，都算这条不通
        }
      }
      apiBase = localSelected ? await probe(localApi()) : (await probe(API)) || (await probe(localApi()))
      if (!apiBase) throw new Error('设置接口不可达；请确认宿主路由或本地设置端口')
      return apiBase
    }

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      // 把响应体也带上：404 时能分清「路由没挂上」和「路径写错了」
      let extra = ''
      try {
        const text = await res.text()
        if (text) extra = ' · ' + text.replace(/\s+/g, ' ').slice(0, 180)
      } catch { /* 读不出来就算了 */ }
      throw new Error('HTTP ' + res.status + why + extra)
    }
    const jget = async (p) => asJson(await fetch((await resolveBase()) + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch((await resolveBase()) + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-qq-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:680px;}
[data-qq-sec]{display:flex;flex-direction:column;gap:8px;}
[data-qq-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qq-row]{display:flex;align-items:center;gap:10px;}
[data-qq-col]{display:flex;flex-direction:column;gap:6px;}
[data-qq-grow]{flex:1;min-width:0;}
[data-qq-label]{font-size:13px;flex:none;min-width:168px;white-space:nowrap;}
@media (max-width:560px){[data-qq-row]{flex-wrap:wrap;}[data-qq-label]{min-width:100%;}}
[data-qq-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qq-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-qq-sw][data-on]{background:#3b82f6;}
[data-qq-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-qq-sw][data-on] i{left:19px;}
[data-qq-sw][disabled]{opacity:.45;cursor:default;}
[data-qq-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-qq-input]:focus{outline:none;border-color:#3b82f6;}
[data-qq-input][data-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;}
[data-qq-area]{width:100%;box-sizing:border-box;min-height:90px;resize:vertical;padding:8px 9px;border-radius:8px;
  font-size:12px;line-height:18px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-qq-area]:focus{outline:none;border-color:#3b82f6;}
[data-qq-num]{width:104px;text-align:center;}
[data-qq-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-qq-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-qq-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-qq-btn][disabled]{opacity:.5;cursor:default;}
[data-qq-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-qq-msg][data-warn]{color:#f59e0b;}
[data-qq-msg][data-good]{color:#22c55e;}
[data-qq-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-qq-dot]{flex:none;width:8px;height:8px;border-radius:50%;background:#9aa0a6;}
[data-qq-dot][data-on]{background:#22c55e;}
[data-qq-pill]{font-size:11px;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
`

    /** 逗号 / 换行 / 空格分隔 → 数组；空串 → [] */
    const toList = (text) => String(text ?? '')
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const fromList = (arr) => (Array.isArray(arr) ? arr.join(', ') : '')

    function Switch({ on, disabled, title, onToggle }) {
      return h('button', {
        'data-qq-sw': '', 'data-on': on ? '' : undefined, disabled: disabled ? '' : undefined,
        title: title || '', type: 'button',
        onClick: () => !disabled && onToggle(!on),
      }, h('i'))
    }

    function Row({ label, hint, children }) {
      return h('div', { 'data-qq-col': '' },
        h('div', { 'data-qq-row': '' },
          h('div', { 'data-qq-label': '' }, label),
          h('div', { 'data-qq-grow': '' }, children)),
        hint ? h('div', { 'data-qq-note': '' }, hint) : null)
    }

    // 人设文件读没读到要常驻显示：读不到最容易「悄悄变普通助手」，
    // 只留一句日志 warn 的话，人在设置页上是看不见的。
    function personaNote(p) {
      if (!p || !p.file) return null
      return h('div', { 'data-qq-note': '' },
        p.ok
          ? `✓ 当前从 ${p.file} 读入 ${p.chars} 字（上面的文本框不生效）`
          : p.fromCache
            ? `⚠️ 这个文件读不到（${p.error || '文件不存在'}），用的是上次读到的那份缓存（${p.chars} 字）`
            : `⚠️ 这个文件读不到（${p.error || '文件不存在'}），现在用的是上面的文本框`)
    }

    function CompatibilityDialog() {
      const [status, setStatus] = useState(null)
      const [acknowledged, setAcknowledged] = useState(false)
      const [dismissed, setDismissed] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const fingerprint = JSON.stringify(status?.versions)
      useEffect(() => {
        let active = true
        const refresh = async () => {
          try { const result = await jget('/status'); if (active) setStatus(result.compatibility) }
          catch (err) { if (active) setError(err.message) }
        }
        refresh()
        const timer = setInterval(refresh, 3000)
        return () => { active = false; clearInterval(timer) }
      }, [])
      useEffect(() => { setAcknowledged(false); setError('') }, [fingerprint])
      useEffect(() => {
        const show = () => setDismissed('')
        window.addEventListener('dsh-qq:show-compatibility', show)
        return () => window.removeEventListener('dsh-qq:show-compatibility', show)
      }, [])
      return h(RiskConfirmation, {
        open: Boolean(status?.pending && dismissed !== fingerprint),
        title: '当前 DSH 版本未经验证',
        description: `QQ 暂未启用。已验证版本：${status?.verifiedVersion ?? ''}。当前核心包：${Object.entries(status?.versions ?? {}).map(([name, version]) => `${name.replace('@deepseek-ai/', '')} ${version}`).join('；')}。继续使用可能导致状态未清理、旧状态进入压缩或会话运行失败。${error ? `操作失败：${error}` : ''}`,
        acknowledgeLabel: '我了解风险，仍要在这些版本上启用 QQ',
        cancelLabel: '暂不启用', closeLabel: '暂不启用', confirmLabel: busy ? '启用中…' : '仍然启用',
        acknowledged, disabled: busy, onAcknowledgedChange: setAcknowledged,
        onCancel: () => { if (!busy) setDismissed(fingerprint) },
        onConfirm: async () => {
          if (!acknowledged || busy) return
          setBusy(true); setError('')
          try {
            const result = await jpost('/compatibility', { versions: status.versions })
            setStatus(result.compatibility)
          } catch (err) { setError(err.message) }
          finally { setBusy(false) }
        },
      })
    }

    function Panel() {
      const [st, setSt] = useState(null)
      const [portDraft, setPortDraft] = useState(String(localPort))
      const [val, setVal] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)
      const [draft, setDraft] = useState({})
      const [groupIdDraft, setGroupIdDraft] = useState('')
      const [persona, setPersona] = useState(null)
      const [syncDeferred, setSyncDeferred] = useState(false)
      const [syncExcluded, setSyncExcluded] = useState([])
      const syncPending = st?.promptSync?.pending ?? []
      const syncOperations = st?.promptSync?.operations ?? []
      const syncRunning = syncOperations.some(item => ['queued', 'running'].includes(item.status))

      const load = useCallback(async () => {
        try {
          const [s, cfg] = await Promise.all([jget('/status'), jget('/settings')])
          setSt(s)
          setVal(cfg.values)
          setDraft({})
          setPersona(cfg.persona ?? null)
        } catch (e) {
          setMsg({ text: '读设置失败：' + e.message, tone: 'warn' })
        }
      }, [])

      useEffect(() => { load() }, [load])

      // 每 15 秒刷一次连接状态（别太勤，设置页不需要实时）
      useEffect(() => {
        const t = setInterval(async () => {
          try { setSt(await jget('/status')) } catch { /* 忽略 */ }
        }, syncRunning ? 1000 : 15000)
        return () => clearInterval(t)
      }, [syncRunning])

      const patch = async (body, label) => {
        setBusy('save')
        setMsg(null)
        try {
          const r = await jpost('/settings', { patch: body })
          setVal(r.values)
          setDraft({})
          if (r.persona) setPersona({ ...r.persona })
          const tail = r.needReconnect ? '（点右边「重连」生效）' : r.needRestart ? '（有几项要重启宿主才生效）' : ''
          let text = `${label} 已保存${tail}`
          if (r.systemChanged && r.promptSync?.pending?.length) {
            text += '，现有会话仍使用原提示词，请选择同步方式'
            setSyncDeferred(false)
          }
          if (r.persona && r.persona.file) {
            text += r.persona.ok ? `，人设从文件读入 ${r.persona.chars} 字` : `，人设文件读不到（${r.persona.error}），先用着原来的`
          }
          setMsg({ text, tone: r.persona && r.persona.file && !r.persona.ok ? 'warn' : 'good' })
          setSt(await jget('/status'))
        } catch (e) {
          setMsg({ text: '保存失败：' + e.message, tone: 'warn' })
        } finally {
          setBusy('')
        }
      }

      const syncPrompts = async action => {
        setBusy('sync')
        try {
          const sessionIds = syncPending.filter(item => !syncExcluded.includes(item.sessionId)).map(item => item.sessionId)
          await jpost('/prompt-sync', { action, sessionIds })
          setSt(await jget('/status'))
          setMsg({ text: '操作已排队，正在回复的会话会等本轮结束后处理。', tone: 'good' })
        } catch (e) { setMsg({ text: '同步失败：' + e.message, tone: 'warn' }) }
        finally { setBusy('') }
      }

      const reconnect = async () => {
        setBusy('reconnect')
        setMsg(null)
        try {
          const r = await jpost('/reconnect')
          setMsg({ text: '已按 ' + r.wsUrl + ' 重连', tone: 'good' })
          setTimeout(load, 1200)
        } catch (e) {
          setMsg({ text: '重连失败：' + e.message, tone: 'warn' })
        } finally {
          setBusy('')
        }
      }

      const localConnection = h('div', { 'data-qq-col': '' },
        h('label', { htmlFor: 'qq-local-api-port' }, '连接本地设置端口'),
        h('input', { id: 'qq-local-api-port', 'data-qq-input': '', type: 'number', min: 1, max: 65535,
          value: portDraft, onChange: e => setPortDraft(e.target.value) }),
        h('button', { 'data-qq-btn': '', type: 'button', onClick: () => {
          const port = Number(portDraft)
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            setMsg({ text: '端口必须是 1–65535 的整数', tone: 'warn' }); return
          }
          localPort = port; localSelected = true; apiBase = null
          setSt(null); setVal(null); setDraft({}); load()
        } }, '连接此端口'),
        h('div', { 'data-qq-note': '' }, '用于宿主路由不可用或多实例时选择目标服务；须与该实例 localApiPort 一致。'))

      if (!val) {
        return h('div', { 'data-qq-page': '' },
          h('div', { 'data-qq-note': '' }, msg ? msg.text : '读取中…'), localConnection)
      }

      const v = (key) => (draft[key] !== undefined ? draft[key] : val[key])
      const setV = (key, value) => setDraft((d) => ({ ...d, [key]: value }))
      const num = (key, fallback = 0) => {
        const n = Number(v(key))
        return Number.isFinite(n) ? n : fallback
      }

      /** 文本 / 数字：失焦才存（边打边存会把半截词写进去） */
      const textField = (key, label, { hint, placeholder, mono, type = 'text', wrap } = {}) => Row({
        label, hint,
        children: wrap
          ? null
          : h('input', {
            'data-qq-input': '', 'data-mono': mono ? '' : undefined, type: type === 'number' ? 'number' : 'text',
            'data-qq-num': type === 'number' ? '' : undefined,
            value: v(key) ?? '',
            placeholder: placeholder || '',
            onChange: (e) => setV(key, e.target.value),
            onBlur: (e) => {
              const raw = e.target.value
              const next = type === 'number' ? (raw === '' ? 0 : Number(raw)) : raw
              if (String(next) !== String(val[key] ?? '')) patch({ [key]: next }, label)
              else setDraft((d) => { const c = { ...d }; delete c[key]; return c })
            },
          }),
      })

      const areaField = (key, label, { hint, rows = 4, mono } = {}) => h('div', { 'data-qq-col': '' },
        h('div', { 'data-qq-label': '' }, label),
        hint ? h('div', { 'data-qq-note': '' }, hint) : null,
        h('textarea', {
          'data-qq-area': '', 'data-mono': mono ? '' : undefined,
          rows,
          value: v(key) ?? '',
          onChange: (e) => setV(key, e.target.value),
          onBlur: (e) => {
            if (String(e.target.value) !== String(val[key] ?? '')) patch({ [key]: e.target.value }, label)
            else setDraft((d) => { const c = { ...d }; delete c[key]; return c })
          },
        }))

      const listField = (key, label, { hint, placeholder } = {}) => Row({
        label, hint,
        children: h('input', {
          'data-qq-input': '', value: draft[key] !== undefined ? draft[key] : fromList(val[key]),
          placeholder: placeholder || '用逗号分隔',
          onChange: (e) => setV(key, e.target.value),
          onBlur: (e) => {
            const list = toList(e.target.value)
            if (toList(fromList(val[key])).join(',') !== list.join(',')) patch({ [key]: list }, label)
            else setDraft((d) => { const c = { ...d }; delete c[key]; return c })
          },
        }),
      })

      const boolField = (key, label, hint) => h('div', { 'data-qq-row': '' },
        h('div', { 'data-qq-grow': '' },
          h('div', { 'data-qq-label': '' }, label),
          hint ? h('div', { 'data-qq-note': '' }, hint) : null),
        h(Switch, { on: Boolean(val[key]), onToggle: (next) => patch({ [key]: next }, label) }))

      const modeField = (key, label, hint) => Row({
        label, hint,
        children: h('select', {
          'data-qq-input': '', style: { width: 150, flex: 'none' },
          value: v(key) ?? 'open',
          onChange: (e) => patch({ [key]: e.target.value }, label),
        },
        h('option', { value: 'open' }, '全都接'),
        h('option', { value: 'allowlist' }, '只接名单里的'),
        h('option', { value: 'disabled' }, '关掉')),
      })

      const connected = Boolean(st && st.connected)

      return h('div', { 'data-qq-page': '' },
        localConnection,
        st?.compatibility?.pending ? h('div', { 'data-qq-msg': '', 'data-warn': '' },
          '当前 DSH 版本未经验证，QQ 暂未启用。',
          h('button', { 'data-qq-btn': '', onClick: () => window.dispatchEvent(new Event('dsh-qq:show-compatibility')) }, '查看风险并选择')) : null,
        st?.compatibility?.accepted ? h('div', { 'data-qq-msg': '', 'data-warn': '' }, '你已接受当前 DSH 版本的运行风险。版本变化后需要重新确认。') : null,
        st?.compatibility?.error ? h('div', { 'data-qq-msg': '', 'data-warn': '' }, `QQ 启用失败：${st.compatibility.error}`) : null,
        /* ── 状态 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-row': '' },
            h('div', { 'data-qq-dot': '', 'data-on': connected ? '' : undefined }),
            h('div', { 'data-qq-label': '', 'data-qq-grow': '' },
              connected ? '已连上 NapCat' : '没连上 NapCat'),
            st ? h('span', { 'data-qq-pill': '' }, st.selfName ? `${st.selfName} (${st.selfId})` : (st.selfId || '未登录')) : null),
          h('div', { 'data-qq-kv': '' },
            '地址：', st ? st.wsUrl : '',
            st && st.home ? h('span', null, h('br'), '家目录：', st.home) : null,
            st && st.settingsFile ? h('span', null, h('br'), '设置文件：', st.settingsFile, '（', st.overrides, ' 条覆盖）') : null),
          h('div', { 'data-qq-row': '' },
            h('button', { 'data-qq-btn': '', disabled: busy === 'reconnect', onClick: reconnect }, '重连'),
            h('button', { 'data-qq-btn': '', onClick: load }, '重新读一遍')),
          msg ? h('div', { 'data-qq-msg': '', 'data-warn': msg.tone === 'warn' ? '' : undefined, 'data-good': msg.tone === 'good' ? '' : undefined }, msg.text) : null),

        syncPending.length ? h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '会话提示词待同步'),
          h('div', { 'data-qq-note': '' }, '配置已保存，以下会话继续使用原提示词。可新建会话、压缩会话，或强制同步。'),
          syncDeferred ? h('button', { 'data-qq-btn': '', onClick: () => setSyncDeferred(false) }, `选择同步方式（${syncPending.length} 个会话）`) : h(React.Fragment, null,
            ...syncPending.map(item => h('label', { key: item.sessionId, 'data-qq-row': '' },
              h('input', { type: 'checkbox', checked: !syncExcluded.includes(item.sessionId), disabled: syncRunning,
                onChange: e => setSyncExcluded(ids => e.target.checked ? ids.filter(id => id !== item.sessionId) : [...ids, item.sessionId]) }), item.label)),
            h('div', { 'data-qq-note': '' }, '创建新会话会切换上下文，旧历史保留在原会话；压缩会保留摘要。'),
            h('div', { 'data-qq-row': '' },
              h('button', { 'data-qq-btn': '', disabled: busy === 'sync' || syncRunning || syncPending.every(item => syncExcluded.includes(item.sessionId)), onClick: () => syncPrompts('new') }, '创建新会话'),
              h('button', { 'data-qq-btn': '', disabled: busy === 'sync' || syncRunning || syncPending.every(item => syncExcluded.includes(item.sessionId)), onClick: () => syncPrompts('compact') }, '压缩会话'),
              h('button', { 'data-qq-btn': '', disabled: busy === 'sync' || syncRunning || syncPending.every(item => syncExcluded.includes(item.sessionId)),
                title: '保留当前会话和完整历史，直接更新 system 提示词，不等待压缩。可能降低后续请求的提示缓存命中率，增加费用和延迟；正在回复时会等本轮结束后执行。',
                onClick: () => syncPrompts('force') }, '强制同步'),
              h('button', { 'data-qq-btn': '', onClick: () => setSyncDeferred(true) }, '稍后同步')))) : null,
        ...syncOperations.slice(-1).map(operation => h('div', { key: operation.id, 'data-qq-msg': '',
          'data-warn': operation.status === 'failed' ? '' : undefined, 'data-good': operation.status === 'done' ? '' : undefined },
          operation.status === 'queued' ? '等待 QQ 运行进程执行同步…' : operation.status === 'running' ? '等待本轮回复结束或正在同步…' : operation.status === 'done' ? '所选会话提示词已同步。' : '部分会话未同步：',
          ...operation.sessions.filter(item => item.status === 'failed').map(item => h('div', { key: item.sessionId }, `${item.label}：${item.error}`)))),

        /* ── 连接 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '连接'),
          textField('wsUrl', 'NapCat 的 WebSocket 地址', {
            hint: 'OneBot 11 正向 WebSocket。NapCat 里开的「正向 WS」默认是 ws://127.0.0.1:3001。改完点上面的「重连」。',
            mono: true,
          }),
          textField('accessToken', 'access token', {
            hint: '跟 NapCat 配置里那一串要一致。只在本机回环可以留空。',
            mono: true,
          }),
          textField('selfId', '机器人自己的 QQ 号', {
            hint: '留空就启动时自动问 NapCat 要（一般不用填）。',
          })),

        /* ── 它是谁 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '它是谁（人设）'),
          areaField('persona', '人设', {
            hint: '名字、性格、怎么称呼对方、有什么小习惯，都写这儿。留空 = 一个没名字、说话正常的普通助手（插件不自带任何角色）。',
            rows: 6,
          }),
          textField('personaFile', '人设文件（地址）', {
            hint: '填了就从文件读人设，盖掉上面的文本框 —— 想让人设跟某个 .md 一起改就填这里。文件读不到时不会把角色弄没，会继续用文本框里的。',
            mono: true,
            placeholder: 'D:/某个角色.md（留空 = 只用上面的文本框）',
          }),
          personaNote(persona),
          textField('ownerLabel', '在群里怎么称呼主人', { hint: '例如「老板」「老大」。', placeholder: '主人' })),

        /* ── 补充提示词 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '补充提示词（追加在内置聊天规矩后面）'),
          areaField('directPrompt', '私聊补充', { rows: 4 }),
          areaField('groupPrompt', '群聊补充', { rows: 6 })),

        /* ── 记忆区 / 工作区 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '记忆区与工作区'),
          textField('preset', 'Agent 工具预设', {
            hint: '填写宿主已有的预设 ID；留空加载宿主默认预设。保存后新会话生效，已有会话保留原预设；可用 /new 创建新会话，原历史不带入。预设中需包含 read_image 才能打开本机图片。',
            mono: true,
          }),
          textField('workspaceRoot', '会话目录根（记忆区在这儿）', {
            hint: '每个私聊 / 每个群在这里各有一个子目录（群_123456 / 私聊_10001），里面的「记忆区/」就是这个会话自己的日记和大纲。留空 = <工作目录>/会话。改完要重启宿主。',
            mono: true,
            placeholder: 'D:/QQ会话（留空就用默认）',
          }),
          boolField('isolateByPeer', '每个会话各自一个目录与记忆区', '关掉的话所有群聊共用宿主的工作目录，别关。改完要重启宿主。')),

        /* ── 当前事项与记忆 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '当前事项与记忆'),
          textField('memoryProvider', '记忆维护 provider', { hint: '留空沿用主会话路由；独立调用，不修改主会话参数。' }),
          textField('memoryModel', '记忆维护模型', { hint: '留空沿用主会话模型。' }),
          textField('memoryTimeoutMs', '维护最长等待（毫秒）', { type: 'number', hint: '默认 30000；失败保留待处理工作，状态显示尚未核实。' }),
          textField('memoryTaskTtlHours', '无明确期限事项的核实间隔（小时）', { type: 'number', hint: '默认 24；无新证据则收起待核实，不等于认定完成。' })),
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '先判断是不是在和我说话'),
          boolField('addressClassifierEnabled', '启用前置判断（群聊与私聊）', '独立会话逐条判断；跳过的消息保留。群聊要求 @ 时仍须结构化 @ 且判断放行；不要求 @ 时由判断结果决定何时处理。关闭后不产生判断请求。'),
          textField('addressClassifierProvider', '判断模型的 provider', { hint: '填写宿主注册的 provider 名称；留空使用插件明确配置的 provider。' }),
          textField('addressClassifierModel', '判断模型', { hint: '填写模型名；留空使用插件明确配置的 model。未明确配置模型时会记录错误并保留消息。' }),
          textField('addressClassifierReasoningEffort', '推理强度', { hint: '默认 low，可以填写模型支持的其他值。' }),
          textField('addressClassifierTimeoutMs', '判断最长等待（毫秒）', { type: 'number', hint: '默认 30000。失败时保留消息，后续放行时一起交付。' })),
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '群里怎么说话'),
          boolField('requireMention', '必须 @ 才接话', '默认开启。必须使用 QQ 的 @ 功能选择机器人；引用、名字和分类器结果不能代替。下方可按群覆盖。'),
          h('div', { 'data-qq-col': '' },
            h('div', { 'data-qq-label': '' }, '按群覆盖必须 @'),
            ...Object.entries(val.groupMentionOverrides ?? {}).map(([id, required]) => h('div', { key: id, 'data-qq-row': '' },
              h('span', null, id),
              h('select', { 'data-qq-input': '', 'aria-label': id + ' 的接话条件', value: String(required),
                onChange: e => patch({ groupMentionOverrides: { ...val.groupMentionOverrides, [id]: e.target.value === 'true' } }, '按群覆盖') },
              h('option', { value: 'true' }, '必须 @'), h('option', { value: 'false' }, '不用 @')),
              h('button', { 'data-qq-btn': '', type: 'button', onClick: () => {
                const next = { ...val.groupMentionOverrides }; delete next[id]
                patch({ groupMentionOverrides: next }, '恢复群聊默认')
              } }, '恢复默认'))),
            h('div', { 'data-qq-row': '' },
              h('input', { 'data-qq-input': '', 'aria-label': '新增覆盖的群号', placeholder: '群号', value: groupIdDraft,
                onChange: e => setGroupIdDraft(e.target.value) }),
              h('button', { 'data-qq-btn': '', type: 'button', onClick: () => {
                const id = groupIdDraft.trim()
                if (!/^\d+$/.test(id)) { setMsg({ text: '请输入有效群号', tone: 'warn' }); return }
                patch({ groupMentionOverrides: { ...val.groupMentionOverrides, [id]: val.requireMention !== false } }, '新增群覆盖')
                setGroupIdDraft('')
              } }, '添加')),
            h('div', { 'data-qq-note': '' }, '未列出的群沿用上方设置。旧免 @ 群名单已迁入这里；群访问控制仍生效。')),
          textField('groupMessageIntervalMs', '普通群聊处理间隔（毫秒）', {
            type: 'number', hint: '默认 30000。仅用于不用 @ 且关闭分类器的群；从第一条消息开始等待，后续消息不延长，自身 @ 或触发词可提前处理。',
          }),
          listField('groupTriggerWords', '立即处理的触发词', { hint: '默认空，用逗号分隔。仅用于不用 @ 且关闭分类器的群；文字包含任一词即提前处理，区分大小写，不匹配引用、历史或 @他人的昵称。自身 @ 始终可提前处理；触发词不强制回复。' }),
          boolField('addressedMaySilent', '被 @ 也允许沉默', '开启后，群聊被 @ 的这一轮也可选择不回复；不改变触发条件。'),
          listField('groupImageBlock', '屏蔽成员图片', { hint: '按群号:QQ号屏蔽全部图片；追加:宽x高仅屏蔽指定尺寸。' }),
          textField('groupMinGapMs', '群里两条消息之间至少隔多久（毫秒）', {
            hint: '默认 4000，防风控。',
            type: 'number',
          }),
          textField('rateLimitPerMin', '每分钟最多发几条', { hint: '默认 12。0 = 不限。被风控往往不是说了什么，是回得太多。', type: 'number' }),
          textField('historyLimit', '每次带多少条群历史', { hint: '默认 20。0 = 不带历史（它会不知道刚才在聊什么）。', type: 'number' })),

        /* ── 谁能跟它说话 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '谁能跟它说话'),
          modeField('privateMode', '私聊', '「只接名单里的」时要填下面的私聊白名单。'),
          listField('privateAllow', '私聊白名单', { hint: 'QQ 号，用逗号分隔。' }),
          modeField('groupMode', '群聊', '「关掉」= 群里完全不理它。'),
          listField('groupAllow', '群聊白名单', { hint: '群号，用逗号分隔。' }),
          listField('ownerIds', '谁是主人（QQ 号）', {
            hint: '这些人在群里说话会标上「主人」的称呼，问本机的事也正常答；其他人一律当陌生人。留空 = 不区分。',
          })),

        /* ── 同类机器人 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '同类机器人（另一个 bot）'),
          boolField('botChatEnabled', '允许它和同类聊天 / 回怼', '默认关：同类说啥都不理，连 @ 也不接。打开之后才会顶嘴——被骂了先看是不是在说它自己。'),
          listField('peerBots', '同类机器人的 QQ 号', { hint: '填了才认得出「这句是别的机器人发的」。' })),

        /* ── 主动说话 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '主动说话（冷场时给一次开口的机会）'),
          boolField('proactiveEnabled', '安静久了允许它主动说一句', '默认开。打开后，会话安静到「安静多久」那个时长，给它一次主动开口的机会——说不说自己判断，不想说就零成本跳过。'),
          textField('proactiveSilentMs', '安静多久之后给机会（毫秒）', {
            hint: '默认 1200000（20 分钟）。说完一句话会重新计时，不会隔几分钟又问一遍。',
            type: 'number',
          }),
          textField('proactiveMaxPerDay', '每天最多主动几次', { hint: '默认 6。连着 3 次没人接就当天闭嘴。', type: 'number' }),
          textField('proactiveQuietHours', '静默时段（这期间不主动）', {
            hint: '默认 23:00-08:00。格式「开始-结束」，24 小时制。',
            mono: true,
          }),
          textField('mergeWindowMs', '连发合并窗口（毫秒）', {
            hint: '默认 5000。同一个人一口气发三条，等这么一会儿并成一轮再回，别回三遍。只在私聊生效。',
            type: 'number',
          })),

        /* ── 作息 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '作息（几点犯困、几点睡）'),
          boolField('sleepMode', '启用作息', '关掉 = 它不分白天黑夜，什么时候都正常回。'),
          textField('bedtimeAt', '几点提醒它去睡', { hint: '默认 23:30。每个会话每天只提醒一次。', mono: true }),
          boolField('holdNightMessages', '休息时段静默', '私聊攒到醒来后回复，群聊直接略过；默认关闭。'),
          textField('sleepFrom', '默认休息开始', {
            hint: '默认 00:00。这段里收到的私聊先攒着，出时段时一次性交出去（附「昨晚你发来这几条」）。',
            mono: true,
          }),
          textField('sleepTo', '默认休息结束', { hint: '默认 08:00。', mono: true }),
          textField('groupSleepFrom', '群聊休息开始', { hint: 'HH:MM，留空沿用默认。', mono: true }),
          textField('groupSleepTo', '群聊休息结束', { hint: 'HH:MM，留空沿用默认。', mono: true }),
          textField('privateSleepFrom', '私聊休息开始', { hint: 'HH:MM，留空沿用默认。', mono: true }),
          textField('privateSleepTo', '私聊休息结束', { hint: 'HH:MM，留空沿用默认。', mono: true })),

        /* ── 其它 ── */
        h('div', { 'data-qq-sec': '' },
          h('div', { 'data-qq-h': '' }, '其它'),
          textField('localApiPort', '独立设置服务端口', { type: 'number', hint: '默认 34569；0 关闭。多实例使用不同端口，修改后重启宿主；连接时在页面顶部选择对应端口。' }),
          textField('doorReplyPrefix', '门口回信前缀', { hint: '默认 回复-；以此前缀命名的文件不计入未读。' }),
          textField('doorSenderLabel', '门口来信来源名称'),
          textField('voiceName', '语音声音名称', { hint: 'Windows SAPI 声音名称；留空使用系统默认声音。' }),
          boolField('debug', '输出调试日志', '日志落在会话目录根的 dsh-qq-debug.log（带 UTC 时间戳）。'),
          textField('textChunkLimit', '单条消息最大字数', { hint: '超出按段落/句号切成多条发。', type: 'number' }),
          textField('splitDelayMs', '分条之间的间隔（毫秒）', { type: 'number' })),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-qq')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-qq: 设置页样式')

        // 0.2.1 里服务直接挂在 ctx 上（官方插件写的就是 ctx.slots）；ctx.get 只作旧式兜底。
        const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
        if (!slots) {
          console.error('[dsh-qq] slots 服务不可用，设置页挂不上去')
          return
        }
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsh-qq', order: 40, label: 'QQ' },
          () => h(Panel),
        ))
        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: 'dsh-qq:host-compatibility', order: 40 },
          CompatibilityDialog,
        ))
      },
    }
  },
})
