/**
 * 设置页的「配置覆盖层」——**让 dsh-qq 的设置能在 DSH 设置界面里改**。
 * ============================================================================
 * 为什么要有这一层（而不是让设置页去改 profile 的 `cordis.patch.yml`）：
 *
 *   · profile 的 patch 是**整行替换 config**，手写 YAML、注释、别的插件都在里面，
 *     一个文本框改错就把整个 profile 弄哑；
 *   · 那个文件属于「宿主配置」，插件不该去动它（权限、热重载语义都不一样）。
 *
 * 所以改成抄 dsh-bili-scroll 的做法：**插件自己的家**里放一份 `settings.json`，
 * 只存「用户改过的键」。启动时用它覆盖 cordis 注入的默认值：
 *
 *     cordis 注入的 config  ←  settings.json 里用户改过的键
 *
 * 家在 `$DSH_HOME/dsh-qq/settings.json`（拿不到 DSH_HOME 就退回 `~/.dsh`）。
 * ⚠️ `ctx.get('dshHomePath')` 返回的是**函数**不是字符串 —— 见 dsh-bili-scroll/lib/state.mjs
 *    那段踩坑记录（当字符串用会把函数源码拼进路径，mkdir ENOENT，插件直接不激活）。
 * ============================================================================
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { migrateGroupSettings, retiredGroupSettings } from './group-trigger.js'
import { migrateOwnerLabel } from './identity.js'

/**
 * 设置页本地服务端口。
 * 插件自己拉起的「小工作台」——DSH 的 /api/dsh-qq 路由不通时，前端会自动回退到这里。
 * 只绑 127.0.0.1，外面访问不到。
 */
export const LOCAL_API_PORT = 34569

/** 能在家目录里被覆盖的键。不在名单里的一律忽略（防止设置页把结构化字段改坏）。 */
export const OVERRIDABLE = [
  // 连接
  'wsUrl',
  'accessToken',
  'selfId',
  'reconnectMs',
  'localApiPort',
  'acceptedDshVersions',
  // Agent 工具预设（现有会话保持原选择，新会话生效）
  'preset',
  // 人设 / 称呼
  'persona',
  'personaFile',
  'ownerIds',
  'ownerLabel',
  'memberLabels',
  'directPrompt',
  'groupPrompt',
  // 工作区与记忆
  'workspaceRoot',
  'isolateByPeer',
  'memoryRoot',
  'memoryProvider',
  'memoryModel',
  'memoryTimeoutMs',
  'memoryTaskTtlHours',
  'imageCacheDir',
  // 触发与节奏
  'addressClassifierEnabled',
  'addressClassifierProvider',
  'addressClassifierModel',
  'addressClassifierReasoningEffort',
  'addressClassifierTimeoutMs',
  'requireMention',
  'groupMentionOverrides',
  'groupMessageIntervalMs',
  'groupTriggerWords',
  'groupImageBlock',
  'groupMinGapMs',
  'rateLimitPerMin',
  'contextTokenizerFamily',
  'groupMode',
  'groupAllow',
  'addressedMaySilent',
  'privateMode',
  'privateAllow',
  'botChatEnabled',
  'peerBots',
  'peerChatMaxTurns',
  // 输出
  'textChunkLimit',
  'showToolResults',
  'splitDelayMs',
  'splitDelayMeanMs',
  'streamReply',
  'streamMaxChunks',
  // 表情包
  'faceCollectHint',
  'faceSendGapMs',
  'faceSendMaxPerHour',
  // 主动说话
  'proactiveEnabled',
  'proactiveSilentMs',
  'proactiveMaxPerDay',
  'proactiveQuietHours',
  // 作息
  'sleepMode',
  'bedtimeAt',
  'sleepFrom',
  'sleepTo',
  'groupSleepFrom',
  'groupSleepTo',
  'privateSleepFrom',
  'privateSleepTo',
  'holdNightMessages',
  'voiceName',
  'goodnightWords',
  // 连发合并
  'mergeWindowMs',
  // 语音
  'asrEnabled',
  'asrPython',
  'asrModel',
  // 其它
  'debug',
]

/**
 * 插件家目录。`ctx.get('dshHomePath')` 可能是函数也可能是字符串，两种都认。
 * @returns {string}
 */
export function homeDirOf(ctx, logger) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('dsh-qq')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'dsh-qq')
    }
  } catch (err) {
    logger?.warn?.('取 dshHomePath 失败，退回 ~/.dsh:', err?.message ?? err)
  }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-qq')
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    logger?.warn?.('创建 dsh-qq 家目录失败:', err?.message ?? err)
  }
  return dir
}

export function settingsFileOf(ctx, logger) {
  return join(homeDirOf(ctx, logger), 'settings.json')
}

/**
 * 第一次启动就落一份**带说明的骨架** settings.json（issue #2 第 4 条）。
 *
 * 为什么：设置页没上场时（浏览器半端没加载），用户手里得有一样「看得到、
 * 改得动」的东西，而不是对着 README 自己拼路径。文件不存在才写，绝不覆盖；
 * 骨架里只有一条 `//` 说明键，**不写 wsUrl/accessToken 的默认值**——
 * 写了会把 profile 里 cordis.patch.yml 配好的连接覆盖掉（骨架变成事故）。
 * `//` 不在 OVERRIDABLE 名单里，读的时候会被静默忽略。
 */
export function ensureSettingsFile(ctx, logger) {
  const file = settingsFileOf(ctx, logger)
  try {
    if (existsSync(file)) return { ok: true, created: false, file }
    const skeleton = {
      '//':
        '这是 dsh-qq 的设置覆盖文件：只写你想改的键，下面的模板复制进这个对象就能用（把这一行 // 删掉）：\n' +
        '  "wsUrl": "ws://127.0.0.1:3001",\n' +
        '  "accessToken": "你自己的 token",\n' +
        '  "selfId": "机器人 QQ 号",\n' +
        '  "privateAllow": ["你的QQ号"]\n' +
        '保存后约 800ms 重新加载。连接地址和凭证需重连；目录与服务等初始化设置需重启运行 QQ 的宿主；固定提示词需按设置页选择同步方式。\n' +
        '⚠ privateMode 默认是 allowlist（只有白名单里的人私聊才会被回应），\n' +
        '  privateAllow 空着就谁都不理——先把自己的号填进上面那行，或者把\n' +
        '  "privateMode": "open" 也写上（只建议在自己机器上、谁都够不着的时候用）。',
    }
    writeFileSync(file, `${JSON.stringify(skeleton, null, 2)}\n`, 'utf8')
    logger?.info?.(`已生成设置骨架 ${file}（文件不存在时才写，不覆盖已有配置）`)
    return { ok: true, created: true, file }
  } catch (err) {
    logger?.warn?.(`创建 ${file} 失败:`, err?.message ?? err)
    return { ok: false, created: false, file, error: err?.message ?? String(err) }
  }
}

/** 启动时坏文件仅使用基础配置；运行中用 strict 拒绝更新，保留上次有效配置。 */
export function loadOverrides(ctx, logger, { strict = false } = {}) {
  const file = settingsFileOf(ctx, logger)
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('设置必须是 JSON 对象')
    return sanitizeOverrides(raw, logger)
  } catch (err) {
    if (strict) throw err
    logger?.warn?.(`读 ${file} 失败，本次启动仅使用基础配置:`, err?.message ?? err)
    return {}
  }
}

/** 在应用配置前持久化迁移结果，不能让旧称呼在下次启动时扩散到新增账号。 */
export function migrateIdentityOverrides(ctx, config, overrides, logger) {
  // 分离部署由运行 QQ 的 profile 迁移，设置进程可能看不到该 profile 的 ownerIds。
  if (config.uiOnly) return overrides
  const migration = migrateOwnerLabel({ ...config, ...overrides })
  if (!migration) return overrides
  const result = saveOverrides(ctx, { ...overrides, ...migration }, logger)
  if (!result.ok) throw new Error(`旧称呼配置迁移失败：${result.error}`)
  return result.overrides
}

/** 只留名单里的键；顺手把 `undefined` / `null` 剔掉（null 表示「清掉这条覆盖」）。 */
export function sanitizeOverrides(input, logger) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  input = migrateGroupSettings(input)
  for (const key of OVERRIDABLE) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const value = input[key]
    if (value === undefined) continue
    if (value === null) continue
    out[key] = value
  }
  validateOverrides(out)
  const dropped = Object.keys(input).filter((k) => !OVERRIDABLE.includes(k))
  if (dropped.length > 0) logger?.debug?.(`设置里有不认识的键，忽略: ${dropped.join(', ')}`)
  return out
}

function validateOverrides(patch) {
  if (patch.memberLabels != null && (typeof patch.memberLabels !== 'object' || Array.isArray(patch.memberLabels) ||
    Object.entries(patch.memberLabels).some(([id, label]) => !/^\d+$/.test(id) || typeof label !== 'string' || label.length > 80 || /[\r\n]/.test(label)))) {
    throw new Error('成员称呼必须是 QQ 号到单行称呼的对象，称呼最多 80 字；用空对象清空')
  }
  if (patch.acceptedDshVersions != null && (typeof patch.acceptedDshVersions !== 'object' || Array.isArray(patch.acceptedDshVersions) ||
    Object.values(patch.acceptedDshVersions).some(value => typeof value !== 'string'))) {
    throw new Error('acceptedDshVersions 必须是包名到版本号的对象')
  }

  if (patch.addressClassifierEnabled != null && typeof patch.addressClassifierEnabled !== 'boolean') {
    throw new Error('addressClassifierEnabled 必须为布尔值')
  }
  if (patch.requireMention != null && typeof patch.requireMention !== 'boolean') {
    throw new Error('requireMention 必须为布尔值')
  }
  if (patch.groupMentionOverrides != null && (typeof patch.groupMentionOverrides !== 'object' || Array.isArray(patch.groupMentionOverrides) ||
    Object.entries(patch.groupMentionOverrides).some(([id, value]) => !/^\d+$/.test(id) || typeof value !== 'boolean'))) {
    throw new Error('按群覆盖必须是群号到布尔值的对象')
  }
  if (patch.groupMessageIntervalMs != null && (!Number.isFinite(patch.groupMessageIntervalMs) || patch.groupMessageIntervalMs < 1)) {
    throw new Error('普通群聊处理间隔必须为正数')
  }
  if (patch.groupTriggerWords != null && (!Array.isArray(patch.groupTriggerWords) || patch.groupTriggerWords.some(word => typeof word !== 'string'))) {
    throw new Error('触发词必须是字符串数组')
  }
  if (patch.addressClassifierTimeoutMs != null && (!Number.isFinite(patch.addressClassifierTimeoutMs) || patch.addressClassifierTimeoutMs <= 0)) {
    throw new Error('addressClassifierTimeoutMs 必须为正数')
  }
  for (const key of ['memoryTimeoutMs', 'memoryTaskTtlHours']) {
    if (patch[key] != null && (!Number.isFinite(patch[key]) || patch[key] <= 0)) throw new Error(`${key} 必须为正数`)
  }
  for (const key of ['memoryProvider', 'memoryModel', 'memoryRoot']) {
    if (patch[key] != null && typeof patch[key] !== 'string') throw new Error(`${key} 必须为字符串`)
  }
  for (const key of ['addressClassifierProvider', 'addressClassifierModel', 'addressClassifierReasoningEffort']) {
    if (patch[key] != null && typeof patch[key] !== 'string') {
      throw new Error(`${key} 必须为字符串`)
    }
  }

  if (patch.localApiPort != null && (!Number.isInteger(patch.localApiPort) || patch.localApiPort < 0 || patch.localApiPort > 65535)) {
    throw new Error('localApiPort 必须为 0–65535 的整数')
  }
  for (const key of ['splitDelayMs', 'splitDelayMeanMs']) {
    if (patch[key] != null && (!Number.isFinite(patch[key]) || patch[key] < 0)) throw new Error(`${key} 必须为非负数`)
  }
}

/** 写覆盖表（整份覆盖，不做增量合并 —— 调用方给的是最终形态）。 */
export function saveOverrides(ctx, overrides, logger) {
  const file = settingsFileOf(ctx, logger)
  const clean = sanitizeOverrides(overrides, logger)
  try {
    writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
    return { ok: true, file, overrides: clean }
  } catch (err) {
    logger?.warn?.('写设置失败:', err?.message ?? err)
    return { ok: false, file, error: err?.message ?? String(err) }
  }
}

const baseConfigs = new WeakMap()
const copySetting = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

// 首次调用必须在应用文件覆盖、读取人设文件之前。
export function captureBaseConfig(config) {
  if (baseConfigs.has(config)) return
  const migrated = migrateGroupSettings(config)
  baseConfigs.set(config, Object.fromEntries(OVERRIDABLE
    .filter(key => Object.hasOwn(migrated, key))
    .map(key => [key, copySetting(migrated[key])])))
}

/** 基础配置加当前覆盖；就地更新共享对象，返回实际变化（含恢复、删除）的键。 */
export function applyOverrides(config, overrides, logger) {
  const applied = []
  if (!config || !overrides) return applied
  captureBaseConfig(config)
  const base = baseConfigs.get(config)
  delete config.groupFree
  for (const key of retiredGroupSettings) delete config[key]
  const effective = { ...base, ...sanitizeOverrides(overrides, logger) }
  for (const key of OVERRIDABLE) {
    try {
      const present = Object.hasOwn(effective, key)
      if (Object.hasOwn(config, key) === present && isDeepStrictEqual(config[key], effective[key])) continue
      if (present) config[key] = copySetting(effective[key])
      else delete config[key]
      applied.push(key)
    } catch (err) {
      logger?.warn?.(`覆盖 ${key} 失败:`, err?.message ?? err)
    }
  }
  return applied
}

const restartKeys = ['localApiPort', 'reconnectMs', 'selfId', 'workspaceRoot', 'isolateByPeer', 'imageCacheDir', 'memoryRoot']
export function settingsEffects(changed) {
  return {
    reconnect: changed.filter(key => ['wsUrl', 'accessToken'].includes(key)),
    restart: changed.filter(key => restartKeys.includes(key)),
    newSession: changed.filter(key => key === 'preset'),
  }
}

/**
 * 「人设地址」：配了 `personaFile` 就从那个文件读人设，读到了就盖掉 `persona`。
 *
 * 读不到时两级兜底（2026-10-26 姐姐说「人设文件那个地方加个兜底」）：
 *   ① 文本框（`persona`）里还有字 → 继续用它；
 *   ② 文本框也是空的（常见：人设全放在文件里）→ 用**上次成功读到的那份缓存**
 *      `$DSH_HOME/dsh-qq/persona-cache.md`。没有这一级的话，文件名一改、一删，
 *      角色就悄无声息变回「一个没有名字的普通助手」，而日志里只有一行 warn。
 * @returns {{ ok: boolean, file?: string, chars?: number, error?: string, fromCache?: boolean }}
 */
export function resolvePersonaFile(config, logger, { home = '' } = {}) {
  const raw = String(config?.personaFile ?? '').trim()
  if (!raw) return { ok: false }
  const file = resolve(raw)
  const cacheFile = home ? join(home, 'persona-cache.md') : ''
  try {
    if (!existsSync(file)) throw new Error('文件不存在')
    const text = readFileSync(file, 'utf8').trim()
    if (!text) throw new Error('文件是空的')
    config.persona = text
    if (cacheFile) {
      try {
        mkdirSync(dirname(cacheFile), { recursive: true })
        writeFileSync(cacheFile, text, 'utf8')
      } catch {
        /* 缓存写不进去不影响这次的人设 */
      }
    }
    logger?.info?.(`人设从 ${file} 读入（${text.length} 字）`)
    return { ok: true, file, chars: text.length }
  } catch (err) {
    const msg = err?.message ?? String(err)
    let fromCache = false
    if (!String(config?.persona ?? '').trim() && cacheFile && existsSync(cacheFile)) {
      try {
        const cached = readFileSync(cacheFile, 'utf8').trim()
        if (cached) {
          config.persona = cached
          fromCache = true
        }
      } catch {
        /* 缓存坏了就当没有 */
      }
    }
    logger?.warn?.(
      `人设文件读不到（${file}）：${msg}` +
        (fromCache ? '，用的是上次读到的那份缓存（persona-cache.md）' : '，继续用 persona 字段'),
    )
    return { ok: false, file, error: msg, fromCache }
  }
}

/** 给设置页看的家目录状态。 */
export function settingsInfo(ctx, logger) {
  const home = homeDirOf(ctx, logger)
  const file = join(home, 'settings.json')
  let mtime = ''
  try {
    if (existsSync(file)) mtime = statSync(file).mtime.toISOString()
  } catch {
    /* 无所谓 */
  }
  return { home, file, exists: existsSync(file), mtime }
}

/**
 * 挂上 `/api/dsh-qq/*` —— 设置页（client.js）打的就是这几个口。
 *
 * @param {object} opts
 * @param {object} opts.ctx          cordis 上下文（**父 ctx**：effect 要挂在它上面才不被提前收掉）
 * @param {object} opts.webServer    由 `ctx.inject(['webServer'], cb)` 拿到的服务实例
 * @param {object} opts.config       运行中的 config（就地读写）
 * @param {object} opts.logger
 * @param {object} [opts.client]     OneBotClient；uiOnly 模式没有
 * @param {object} [opts.manager]    SessionManager；uiOnly 模式没有
 * @param {object} opts.personaRef   `{ current: {ok,file,chars} }`，保存后刷新这里
 * @param {object} opts.overridesRef `{ current: {} }`，设置页存下来的覆盖
 * @returns {boolean} 是否挂上
 */
export function installSettingsApi({ ctx, webServer: injectedWebServer, config, logger, client, manager, personaRef, overridesRef, promptSync, compatibility, getRuntime }) {
  captureBaseConfig(config)
  // 自证：这次到底有没有把路由挂上（排查「设置页 404」时不用靠猜）
  const noteApiState = (ok, detail) => {
    try {
      writeFileSync(join(homeDirOf(ctx, logger), 'api-state.txt'), `${new Date().toISOString()} ok=${ok} ${detail || ''}\n`, 'utf8')
    } catch { /* 写不了就算了，别影响注册 */ }
  }

  const sendJson = (res, status, body) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch (err) {
      logger?.debug?.('回 JSON 失败:', err?.message ?? err)
    }
  }

  const readJsonBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 2 * 1024 * 1024) throw new Error('请求体太大（>2MB）')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  /** 设置页看到的「当前生效值」——只给可改的键，不把整个 config 抖出去。 */
  const snapshot = () => {
    const values = {}
    for (const key of OVERRIDABLE) {
      if (config[key] !== undefined) values[key] = config[key]
    }
    return values
  }

  const statusOf = () => {
    const { client: liveClient = client, manager: liveManager = manager, promptSync: liveSync = promptSync } = getRuntime?.() ?? {}
    const info = settingsInfo(ctx, logger)
    return {
      ok: true,
      uiOnly: Boolean(config.uiOnly),
      connected: Boolean(liveClient?.connected),
      wsUrl: config.wsUrl,
      selfId: (liveManager?.selfId || String(config.selfId ?? '')) || '',
      selfName: liveManager?.selfName || '',
      persona: {
        ok: Boolean(personaRef?.current?.ok),
        fromFile: Boolean(personaRef?.current?.ok),
        fromCache: Boolean(personaRef?.current?.fromCache),
        file: personaRef?.current?.file ?? String(config.personaFile ?? ''),
        chars: String(config.persona ?? '').length,
        error: personaRef?.current?.error ?? '',
      },
      home: info.home,
      settingsFile: info.file,
      settingsExists: info.exists,
      overrides: Object.keys(overridesRef?.current ?? {}).length,
      promptSync: liveSync?.status() ?? { pending: [], operations: [] },
      compatibility: compatibility?.status() ?? null,
    }
  }

  const handleApi = async (req, res) => {
    const { client: runtimeClient = client, promptSync: runtimeSync = promptSync } = getRuntime?.() ?? {}
    const url = new URL(req.url, 'http://127.0.0.1')
    // ⚠️ 宿主给 prefix 路由的 req.url 有两种形态：完整路径（/api/dsh-qq/status），
    //    或者已经被剥掉前缀的（/status）。两种都认，不然会一直 404。
    const raw = url.pathname
    const path = raw.startsWith('/api/dsh-qq')
      ? raw
      : '/api/dsh-qq' + (raw.startsWith('/') ? raw : '/' + raw)

    if (req.method === 'GET' && path === '/api/dsh-qq/status') {
      return sendJson(res, 200, statusOf())
    }

    if (req.method === 'POST' && path === '/api/dsh-qq/compatibility') {
      if (!compatibility) return sendJson(res, 503, { ok: false, error: '宿主版本确认服务未启动' })
      const body = await readJsonBody(req)
      try { compatibility.validate(body.versions) }
      catch (err) { return sendJson(res, 409, { ok: false, error: err.message }) }
      const accepted = { ...body.versions }
      const saved = saveOverrides(ctx, { ...loadOverrides(ctx, logger, { strict: true }), acceptedDshVersions: accepted }, logger)
      if (!saved.ok) return sendJson(res, 500, { ok: false, error: saved.error })
      config.acceptedDshVersions = accepted
      if (overridesRef) overridesRef.current = saved.overrides
      compatibility.sync()
      return sendJson(res, 200, { ok: true, compatibility: compatibility.status() })
    }

    if (req.method === 'POST' && path === '/api/dsh-qq/prompt-sync') {
      if (!runtimeSync) return sendJson(res, 503, { ok: false, error: '提示词同步服务未启动' })
      const body = await readJsonBody(req)
      try {
        return sendJson(res, 202, { ok: true, operation: runtimeSync.request(body.action, body.sessionIds) })
      } catch (err) { return sendJson(res, 400, { ok: false, error: err?.message ?? String(err) }) }
    }

    if (req.method === 'GET' && path === '/api/dsh-qq/settings') {
      const info = settingsInfo(ctx, logger)
      return sendJson(res, 200, {
        ok: true,
        values: snapshot(),
        overrides: { ...(overridesRef?.current ?? {}) },
        meta: { ...info, personaFromFile: Boolean(personaRef?.current?.ok), overridable: OVERRIDABLE },
      })
    }

    if (req.method === 'POST' && path === '/api/dsh-qq/settings') {
      const body = await readJsonBody(req)
      const rawPatch = body && Object.hasOwn(body, 'patch') ? body.patch : body
      if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) return sendJson(res, 400, { ok: false, error: '要一个对象' })
      const patch = migrateGroupSettings(rawPatch)
      if (Object.hasOwn(patch, 'ownerLabel')) {
        return sendJson(res, 400, { ok: false, error: 'ownerLabel 已停用，请使用 memberLabels 按账号设置称呼' })
      }
      try { validateOverrides(patch) }
      catch (err) { return sendJson(res, 400, { ok: false, error: err.message }) }

      // 值是 null = 清掉这条覆盖，回到 cordis 里的默认值
      const systemBefore = JSON.stringify(runtimeSync?.status().pending ?? [])
      const valuesBefore = copySetting(snapshot())
      const next = { ...(overridesRef?.current ?? {}) }
      for (const [key, value] of Object.entries(patch)) {
        if (!OVERRIDABLE.includes(key)) continue
        if (value === null) delete next[key]
        else next[key] = value
      }

      const saved = saveOverrides(ctx, next, logger)
      if (!saved.ok) return sendJson(res, 500, { ok: false, error: saved.error, file: saved.file })

      // 就地应用：下游模块拿的就是这同一个 config 对象，所以绝大多数键立刻生效
      if (overridesRef) {
        for (const key of Object.keys(overridesRef.current ?? {})) delete overridesRef.current[key]
        Object.assign(overridesRef.current, saved.overrides)
      }
      applyOverrides(config, saved.overrides, logger)
      compatibility?.sync()
      const currentRuntime = getRuntime?.()
      currentRuntime?.wake?.sync()
      currentRuntime?.bedtime?.sync()
      const personaNow = resolvePersonaFile(config, logger, { home: homeDirOf(ctx, logger) })
      if (personaRef) personaRef.current = personaNow

      const effects = settingsEffects(OVERRIDABLE.filter(key => !isDeepStrictEqual(valuesBefore[key], config[key])))
      const promptStatus = (getRuntime?.().promptSync ?? runtimeSync)?.status() ?? { pending: [], operations: [] }

      return sendJson(res, 200, {
        ok: true,
        values: snapshot(),
        file: saved.file,
        persona: personaNow,
        needReconnect: effects.reconnect.length > 0,
        needRestart: effects.restart.length > 0,
        effects,
        promptSync: promptStatus,
        systemChanged: systemBefore !== JSON.stringify(promptStatus.pending),
      })
    }

    // 改了 wsUrl / token 之后不用重启整个宿主，把客户端重开一次就行
    if (req.method === 'POST' && path === '/api/dsh-qq/reconnect') {
      if (compatibility?.status().pending) return sendJson(res, 409, { ok: false, error: '请先确认 DSH 版本风险，再启用 QQ' })
      if (!runtimeClient) return sendJson(res, 400, { ok: false, error: 'QQ 尚未启用，或此实例只提供设置页；请检查运行端状态' })
      try {
        runtimeClient.stop()
        runtimeClient.url = config.wsUrl
        runtimeClient.token = config.accessToken
        runtimeClient.start()
        return sendJson(res, 200, { ok: true, wsUrl: runtimeClient.url })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
      }
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  // 统一的请求处理体：两条路（DSH 路由 / 本地服务）共用同一份逻辑。
  const routeHandler = async (req, res) => {
    try {
      await handleApi(req, res)
    } catch (err) {
      logger?.warn?.('设置页接口出错:', err?.message ?? err)
      sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
    }
  }

  let mounted = false

  // ── 路 1：DSH 自带的 webServer ───────────────────────────────────────────
  // 能挂就挂（同源、免 CORS，最好用）。挂了但请求 404 也不影响下面那条兜底。
  if (injectedWebServer) {
    try {
      ctx.effect(
        () =>
          injectedWebServer.register({
            kind: 'prefix',
            path: '/api/dsh-qq',
            handler: routeHandler,
          }),
        'dsh-qq: /api/dsh-qq 设置页接口',
      )
      mounted = true
    } catch (err) {
      logger?.warn?.('DSH 路由没挂上（还有本地服务兜底）:', err?.message ?? err)
    }
  }

  // ── 路 2：插件自己的本地小服务（2026-10-24 加的兜底）─────────────────────
  // 为什么要有它：DSH 那边的路由实测会「register 成功、请求却 404」，
  // 调了两轮都没绕过去。插件自己监听 127.0.0.1 就完全不依赖宿主内部机制，
  // 这也是官方教程里说的插件形态（「插件在本地拉起一个 web 工作台」）。
  // 只绑 127.0.0.1，外面访问不到；CORS 放开是给 DSH 页面里的 client 用。
  const localPort = Number(config.localApiPort ?? LOCAL_API_PORT)
  if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) throw new Error('localApiPort 必须为 0–65535 的整数')
  if (localPort !== 0) {
    try {
      const local = createServer(async (req, res) => {
        res.setHeader('access-control-allow-origin', '*')
        res.setHeader('access-control-allow-headers', 'content-type')
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }
        await routeHandler(req, res)
      })
      local.on('error', (err) => {
        logger?.warn?.(`本地设置服务起不来（端口 ${localPort}）: ${err?.message ?? err}`)
      })
      local.listen(localPort, '127.0.0.1', () => {
        logger?.info?.(`设置页本地服务: http://127.0.0.1:${localPort}/api/dsh-qq`)
      })
      ctx.effect(
        () => () => {
          try {
            local.close()
          } catch {
            /* 收摊 */
          }
        },
        'dsh-qq: 本地设置服务',
      )
      mounted = true
    } catch (err) {
      logger?.warn?.('本地设置服务没起来:', err?.message ?? err)
    }
  }

  noteApiState(
    mounted,
    `${injectedWebServer ? 'DSH 路由已尝试' : '没有 DSH 路由'} + ${localPort ? '本地服务 ' + localPort : '独立服务已关闭'}`,
  )
  return mounted
}
