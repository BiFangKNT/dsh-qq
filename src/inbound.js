import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readPlainText, readMessage, readCommandText } from './onebot/segment.js'
import { rememberFaces, facesCount } from './faces.js'
import { faceCollectRule, IMAGE_RULES, QUOTE_DIRECTION_HINT } from './prompts.js'
import { createAddressClassifier } from './address-classifier.js'
import { migrateGroupSettings, requiresGroupMention, groupMessageInterval } from './group-trigger.js'
import { resolvePeerWorkspace } from './workspace.js'
import { listOf } from './config.js'
import { allowPrivate, allowGroup } from './access.js'
import { memberLabel } from './identity.js'
import { imagePolicy, blocksImage } from './image-filter.js'
import { appendChatLog, CHATLOG_DIR, UNAUTHORIZED_LOG_DIR } from './chatlog.js'
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

/** 插件自带的 ASR 脚本；配置里没写 asrScript 时用它。 */
const DEFAULT_ASR_SCRIPT = fileURLToPath(new URL('../tools/asr.py', import.meta.url))

/**
 * 跑一次离线 ASR：python asr.py <wav> [model] → {ok, text}
 * 任何异常都吞掉返回空串，绝不让语音把主链路拖死。
 */
function runAsr(config, wavPath) {
  return new Promise((resolve) => {
    const py = config.asrPython || 'python'
    const script = config.asrScript || DEFAULT_ASR_SCRIPT
    if (!script) return resolve('')
    const model = String(config.asrModel ?? '').trim()
    let out = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    let child
    try {
      child = spawn(py, model ? [script, wavPath, model] : [script, wavPath], { windowsHide: true })
    } catch {
      return resolve('')
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish('')
    }, Number(config.asrTimeoutMs) || 60000)
    child.stdout?.on('data', (d) => {
      out += d.toString('utf8')
    })
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      finish('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const line = out.trim().split('\n').filter(Boolean).pop() || ''
        const json = JSON.parse(line)
        finish(json.ok ? String(json.text || '') : '')
      } catch {
        finish('')
      }
    })
  })
}

function commandOf(message, selfId, isGroup) {
  const text = readCommandText(message, { selfId, requireMention: isGroup })
    .toLowerCase().replace(/／/g, '/')
  return /^[/#](reset|new|status|cwd|help)$/.test(text) ? text : ''
}

/** 同类机器人「连着聊」的计数（键：对面那个号）。
 *  2026-10-29 姐姐要「能私聊，也能停」：私聊里两只鲸鲸互相回话没有天然终点——
 *  A 回 B，B 又回 A，每轮都算「有人跟我说话」，出站限流只能把它压慢、停不下来。
 *  这里数「连着接了几轮」，超过 peerChatMaxTurns 就先不接；真人一开口整张表清空。
 *  纯内存，进程重启就没了 —— 它管的是「正在连聊」，不跨重启也算数。 */
const peerChatTurns = new Map()

/** 连聊计数的有效期：半小时没动静就重新算。半夜聊两句，别让白天的账还挂着。 */
const PEER_CHAT_TURN_WINDOW_MS = 30 * 60_000

/** 这条消息是不是「同类」（群里另一个机器人）发的。
 *  两条判断：`sender.is_robot`（NapCat 对群机器人会带，但不是每只都带），
 *  以及配置里的 `peerBots` 名单（QQ 号）——名单最可靠，兜底。 */
function isPeerBot(config, senderId, event) {
  const id = String(senderId ?? '')
  if (!id) return false
  if ((config?.peerBots ?? []).map(String).includes(id)) return true
  return event?.sender?.is_robot === true
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 一天里的大概时段，用来说「下午/晚上」时不用模型自己换算。 */
function periodOf(hour) {
  if (hour < 5) return '凌晨'
  if (hour < 8) return '早上'
  if (hour < 11) return '上午'
  if (hour < 13) return '中午'
  if (hour < 17) return '下午'
  if (hour < 19) return '傍晚'
  if (hour < 23) return '晚上'
  return '深夜'
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 本地时区的今天 YYYY-MM-DD。
 *  ⚠️ 别用 `toISOString().slice(0,10)` —— 那是 UTC，+08 时区凌晨 0–8 点会算成昨天。 */
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 人话时间（完整版）：2026-10-24 周六 13:05（下午）。
 *  直接给模型一句能照念的话，别让它拿 ISO 时间戳自己换算白天晚上。 */
function humanTime(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${WEEKDAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}（${periodOf(d.getHours())}）`
}

/** 历史行里的短时间：10-24 周六 13:05（下午）。一条消息只占一行，别太长。 */
function historyTime(d = new Date()) {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${WEEKDAYS[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}（${periodOf(d.getHours())}）`
}

/**
 * 这一轮「必须回」还是「可以沉默」。
 *
 * - 私聊：默认回应。
 * - 群里被协议消息段 @：默认回应；
 *   `addressedMaySilent` 打开后，被叫也允许沉默。
 * - 其他群消息只作为背景，或在免 @ 模式下定时处理并允许沉默。
 * - 补发和分类器放行不改变原消息的回复要求。
 */
export function mustReplyFor({
  isGroup,
  atMe = false,
  addressedMaySilent = false,
} = {}) {
  if (!isGroup) return true
  return atMe && addressedMaySilent !== true
}

// 转义来源标记分隔符，减少昵称或正文与插件标记混淆；不替代工具层的权限检查。
function seal(value) {
  return String(value ?? '').replace(/⟨/g, '〈').replace(/⟩/g, '〉')
}

// 多行消息的漏洞：对方发三行，第二行要是以 ⟨ 开头，它就成了「行首」。
// 所以正文里**每一个行首的 ⟨** 都换成同形字——这样「行首那对 ⟨⟩ 才是信封」这条硬规矩不会漏。
// 只动行首，正文中间的 ⟨⟩ 原样留着（不是行首就不可能是信封）。
function sealBody(text) {
  return String(text ?? '').replace(/(^|\n)([ \t]*)⟨/g, '$1$2〈')
}

/** 转录来源、时间与可选称呼；授权和称呼分别标记。 */
export function historyLine(sender, text, { isOwner = false, label = '', isSelf = false, selfName = '机器人', isBot = false } = {}) {
  const body = sealBody(text)
  if (isSelf) return `⟨你（${seal(selfName || '机器人')}） ${historyTime()}⟩ ${body}`
  const name = seal(sender?.card || sender?.nickname || String(sender?.user_id ?? ''))
  // 同类机器人单独标一下：不标的话，它跟群友的话在历史里长得一样，
  // 「这句是在跟我说，还是跟它说」就永远分不清（用户 2026-10-24 的原话）。
  const tag = [isOwner ? ' · 授权账号' : '', isBot ? ' · 同类机器人' : '',
    label ? ` · 称呼 ${seal(JSON.stringify(label))}` : ''].join('')
  return `⟨${name} (${sender?.user_id ?? ''})${tag} ${historyTime()}⟩ ${body}`
}

/** 仅供状态诊断的有限窗口，不再补入主模型上下文。 */
export function pushHistory(record, entry) {
  if (!record || !entry) return
  if (!Array.isArray(record.history)) record.history = []
  record.history.push(String(entry).slice(0, 2000))
  const keep = 200
  if (keep > 0 && record.history.length > keep) {
    record.history.splice(0, record.history.length - keep)
  }
}

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
}

function guessExt(url, mime) {
  const byMime = EXT_BY_MIME[mime]
  if (byMime) return byMime
  const fromUrl = extname(new URL(url, 'http://x').pathname || '').toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(fromUrl) ? fromUrl : '.png'
}

const FORWARD_MAX_ITEMS = 30
const FORWARD_MAX_CHARS = 2000

/**
 * 合并转发（群里那张「聊天记录」卡片）展开成纯文本。
 *
 * OneBot 的 forward 段只带一个 id，内容要另外调 get_forward_msg 取。
 * 不展开的话，agent 在群里只看得见「[合并转发]」四个字——等于那段话没说过。
 * 取不到就如实标出来，别装成看见了。
 */
export async function expandForwards(client, forwards, { logger } = {}) {
  if (!Array.isArray(forwards) || forwards.length === 0) return ''
  const out = []

  for (const f of forwards) {
    if (!f?.id) {
      out.push('[合并转发·拿不到 id]')
      continue
    }

    let res
    try {
      // NapCat 认 message_id，标准 OneBot 写 id——两个都递过去，谁认谁接
      res = await client.call('get_forward_msg', { message_id: f.id, id: f.id })
    } catch (err) {
      logger?.debug?.(`[dsh-qq] 合并转发取不到（${f.id}）：${err?.message || err}`)
      out.push('[合并转发·展开失败]')
      continue
    }

    const list = Array.isArray(res?.messages) ? res.messages : res?.message ? [res] : []
    if (list.length === 0) {
      out.push('[合并转发·空的]')
      continue
    }

    const lines = []
    let used = 0
    for (const item of list) {
      if (lines.length >= FORWARD_MAX_ITEMS || used >= FORWARD_MAX_CHARS) {
        lines.push(`…（还差 ${list.length - lines.length} 条没放进来，太长了）`)
        break
      }
      const who = String(item?.sender?.card || item?.sender?.nickname || item?.sender?.user_id || '?')
      const body = readMessage(item?.message, {}).text || '[无文字]'
      const line = `${who}：${body}`
      used += line.length
      lines.push(line)
    }
    out.push(`[合并转发 ${list.length} 条]\n${lines.join('\n')}`)
  }

  return out.join('\n')
}

/**
 * 下载一张图到本地缓存，返回绝对路径；失败返回 null。
 * 只接受 http(s) 和 base64:// 两种来源。
 *
 * export 出去是因为 `qq_images`（tools.js）也要用同一条下载路径：
 * 按消息 id 现取图的时候，落到跟收消息一样的缓存目录里，用完能一起被清。
 */
async function loadImage(url, maxMB) {
  let data, ext
  if (url?.startsWith('base64://')) {
    data = Buffer.from(url.slice('base64://'.length), 'base64')
    ext = '.png'
  } else {
    if (!/^https?:\/\//i.test(url ?? '')) throw new Error('图片来源必须为 HTTP(S) 或 base64')
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`图片下载失败：HTTP ${res.status}`)
    data = Buffer.from(await res.arrayBuffer())
    ext = guessExt(url, res.headers.get('content-type') ?? '')
  }
  if (data.length > maxMB * 1024 * 1024) throw new Error('图片超过大小限制')
  return { data, ext }
}

async function cacheImage(image, cacheDir) {
  const path = join(cacheDir, `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${image.ext}`)
  await writeFile(path, image.data)
  return path
}

export async function downloadImage(url, cacheDir, maxMB, policy) {
  try {
    if (!url || policy?.all) return null
    const image = await loadImage(url, maxMB)
    if (blocksImage(image.data, policy)) return null
    return await cacheImage(image, cacheDir)
  } catch { return null }
}

/** 清掉缓存里太老的图，避免堆成垃圾场。 */
async function pruneCache(cacheDir, protectedPaths, keepFiles = 200) {
  try {
    const names = (await readdir(cacheDir)).filter((n) => n.startsWith('qq-'))
    if (names.length <= keepFiles) return
    const stats = await Promise.all(
      names.filter(n => !protectedPaths.has(join(cacheDir, n))).slice(0, names.length - keepFiles).map(async (n) => {
        const p = join(cacheDir, n)
        try {
          const { stat } = await import('node:fs/promises')
          const s = await stat(p)
          return { p, mtime: s.mtimeMs }
        } catch {
          return null
        }
      }),
    )
    for (const item of stats.filter(Boolean).slice(0, 20)) {
      await unlink(item.p).catch(() => {})
    }
  } catch {
    /* 清缓存失败不影响主链路 */
  }
}

/**
 * 入站：OneBot 消息事件 → agent.followup()。
 *
 * 触发规则全部走配置，插件自己不做「猜你还想聊」这种自作聪明的事。
 */
export function createInbound({ config, manager, logger, client, send, approval, questions, contextGuard, wake, sleep, bridge, addressClassifier }) {
  if (listOf(config.groupFree).length) config.groupMentionOverrides = migrateGroupSettings(config).groupMentionOverrides
  addressClassifier ??= createAddressClassifier({ config, logger })
  // 没配 imageCacheDir 时落在工作目录下的「图片缓存」；每个会话再各占一层子目录（见下）
  const baseCacheDir =
    String(config.imageCacheDir ?? '').trim() ||
    join(String(config.cwd ?? '').trim() || process.cwd(), '图片缓存')
  const maxMB = Number(config.imageMaxMB) || 8
  // 每次读取当前配置，授权身份与称呼分别标记。
  const identityOf = id => ({ isOwner: listOf(config.ownerIds).includes(String(id)), label: memberLabel(config, id) })
  const messageStats = meta => {
    const labels = { pending: '待交付', reserved: '接纳中', admitted: '已接纳', processed: '已处理',
      failed: '未完成', omitted: '未提供', control: '控制消息', 'legacy-accepted': '旧版已接纳' }
    return addressClassifier.store.stats(meta).map(row => `${labels[row.status] ?? row.status} ${row.count}`).join('，') || '无'
  }

  // 连发合并：同一个 peer 的几条消息攒在一起回。
  // 键是「谁发的」，值是正在等的这一批（bodies 是各自已经拼好的正文）。
  const groupTimers = new Map()
  const turnTimers = new Set()
  let triggerVersion = null
  const ingressQueues = new Map()
  const preparingSources = new Set()
  const preparingAttachments = new Set()
  let disposed = false

  const seenMessages = new Map()

  const handleEvent = async event => {
    const attachments = new Set()
    preparingAttachments.add(attachments)
    try {
      await processEvent(event, attachments)
      if (disposed || attachments.size === 0) return
      const protectedPaths = addressClassifier?.pendingAttachmentPaths() ?? new Set()
      for (const files of preparingAttachments) {
        for (const path of files) protectedPaths.add(path)
      }
      for (const dir of new Set([...attachments].map(path => dirname(path)))) {
        await pruneCache(dir, protectedPaths)
      }
    } finally {
      preparingAttachments.delete(attachments)
    }
  }

  const processEvent = async (event, attachments) => {
    if (disposed) return
    if (event?.post_type !== 'message') return
    const selfId = String(event.self_id ?? manager.selfId ?? '')
    if (event.self_name) manager.selfName = String(event.self_name)
    if (event.user_id !== undefined && String(event.user_id) === selfId) return

    const isGroup = event.message_type === 'group'
    const scope = isGroup ? 'group' : 'private'
    const peerId = String(isGroup ? event.group_id : event.user_id)
    const classified = Boolean(config.addressClassifierEnabled && addressClassifier)
    const sender = event.sender ?? {}
    const senderName = sender.card || sender.nickname || peerId
    const label = isGroup ? `群 ${peerId}` : `私聊 ${senderName}(${peerId})`
    const ownerInfo = identityOf(event.user_id)
    // 2026-10-29 姐姐：「有没有办法能做到能私聊，但是能停下」——同类判定不再锁在群里，
    // 私聊也按 peerBots 名单认。于是 botChatEnabled 变成全局总闸：关掉 = 私聊里的同类也不接。
    const peerBot = isPeerBot(config, event.user_id, event)
    if (peerBot) ownerInfo.isBot = true

    const allowed = isGroup ? allowGroup(config, peerId) : allowPrivate(config, peerId)
    if (!event.__classifierRecovery && event.message_id !== undefined && event.message_id !== null) {
      const now = Date.now()
      for (const [key, expires] of seenMessages) {
        if (expires <= now) seenMessages.delete(key)
        else break
      }
      const key = JSON.stringify([selfId, scope, peerId, String(event.message_id)])
      if (seenMessages.has(key)) return
      seenMessages.set(key, now + 10 * 60_000)
      if (seenMessages.size > 4096) seenMessages.delete(seenMessages.keys().next().value)
    }
    const policy = imagePolicy(config, isGroup ? peerId : null, event.user_id)
    const blockImages = policy.all
    const info = readMessage(event.message, {
      selfId, selfName: event.self_name ?? '机器人', blockImages,
    })

    // 合并转发：卡片里的内容真的取出来，摆进正文，别只留一个「[合并转发]」。
    // 取不到就保留占位——至少让人知道这里本来有东西。
    if (info.forwards.length > 0) {
      const expanded = await expandForwards(client, info.forwards, { logger })
      if (expanded) info.text = info.text ? `${info.text}\n${expanded}` : expanded
    }

    // 纯图 / 纯语音 / 纯文件 / 纯表情包（没有文字）也要处理
    if (
      !info.text &&
      info.images.length === 0 &&
      info.records.length === 0 &&
      info.files.length === 0 &&
      info.mfaces.length === 0
    ) {
      return
    }

    // 聊天流水：跳过的消息也先记下来——「它怎么突然接不上话」全靠这段回查。
    // 只落盘、不参与投递，写失败也不影响聊天。
    // 白名单外的落到 `聊天记录/_未开通/`（2026-10-26 姐姐定的）：留痕，不投递。
    if (config.chatLog !== false && !event.__classifierRecovery) {
      const logDir = resolvePeerWorkspace(config, scope, peerId)
      const who = `${senderName}(${event.user_id})`
      appendChatLog(
        logDir,
        { who, text: info.text || '[图片]', msgId: event.message_id },
        logger,
        allowed ? undefined : join(CHATLOG_DIR, UNAUTHORIZED_LOG_DIR),
      ).catch(() => {})
    }

    if (!allowed) {
      logger.debug?.(`[dsh-qq] 忽略未授权 ${label}`)
      return
    }

    const senderId = String(event.user_id ?? '')

    // ── 引用：先查一次「这句在接谁的话」。
    // 一次 get_msg 同时干两件事：判断这条是不是在跟我说话（下面），以及给正文加引用提示（再下面）。
    // 只有真带引用才发请求，群里引用不常见，不会拖慢平时。
    let quoteInfo = null
    if (info.replyId && client) {
      try {
        const quoted = await client.call('get_msg', { message_id: Number(info.replyId) }, 8000)
        const quotedUserId = String(quoted?.sender?.user_id ?? '')
        const quotedName =
          quoted?.sender?.card || quoted?.sender?.nickname || quotedUserId || '某人'
        const quotedInfo = readMessage(quoted?.message, {
          selfId,
          selfName: event.self_name ?? '机器人',
        })
        quoteInfo = {
          userId: quotedUserId,
          name: quotedName,
          text: (quotedInfo.text || '[非文字内容]').replace(/\s+/g, ' ').slice(0, 80),
          ok: true,
        }
      } catch (err) {
        logger.debug?.(`[dsh-qq] 取引用原文失败: ${err?.message || err}`)
        // 取不到就当没有引用：不知道该接谁的话，宁可不接，也别猜。
        quoteInfo = { userId: '', name: '', text: '', ok: false }
      }
    }
    // 同类机器人（群里另一个机器人）：开关关着就完全不接，连 @ 也不接。
    // 用户 2026-10-24：「吵架功能单独做个开关，这个开关控制它要不要和同类聊天，以及对比较冲的同类回怼」。
    // 关着的时候它说什么都跟我们无关 —— 同类之间的帐先不算。
    if (peerBot && !config.botChatEnabled) {
      logger.debug?.(`[dsh-qq] ${label} 是同类机器人发言，「和同类聊天」没开，跳过`)
      // 不接它的话，但它说了什么得留下 —— 下次真接的时候，得知道它刚讲过什么。
      return
    }

    if (!peerBot) peerChatTurns.clear()

    let record = await manager.obtain({ scope, peerId, label })
    // 有人说话了：冷场计时要清零，主动说话那层也知道「这会儿不缺人」


    // 这个会话自己的缓存目录（隔离模式下一会话一目录；关掉隔离就共用 baseCacheDir）
    const cacheDir = record.dir ? join(record.dir, '图片缓存') : baseCacheDir

    // ── 先看这句是不是在回答一条待审批的请求；是的话就吃掉，不投给 Agent ──
    const rawText = (info.text || '').trim()
    if (rawText && approval?.tryResolve?.(record, rawText)) {
      logger.info?.(`[dsh-qq] 已消化审批回复 ${label}`)
      return
    }

    // ── 再看是不是在回答一条待答的问题 ──
    if (rawText && questions?.tryResolve?.(record, rawText)) {
      logger.info?.(`[dsh-qq] 已消化问答回复 ${label}`)
      return
    }

    // 群命令必须通过协议消息段显式 @ 自身，保活和分类器不代替这个条件。
    const cmd = commandOf(event.message, selfId, isGroup)
    if (cmd === '/reset' || cmd === '#reset' || cmd === '/new' || cmd === '#new') {
      await manager.enqueue(record, async () => {
        await manager.replaceSession(record)
        logger.info?.(`[dsh-qq] 收到 ${cmd}（${label}），已切换到 ${record.sessionId}`)
        await send(record, '好，已新建会话；当前事项和有效记忆会保留。')
      })
      return
    }
    if (cmd === '/status' || cmd === '#status') {
      await send(
        record,
        [
          `会话：${record.label}`,
          `id：${record.sessionId}`,
          `消息记录：${messageStats({ selfId, scope, peerId })}`,
          `我这边：${record.busy > 0 ? '还在忙' : '空闲'}`,
        ].join('\n'),
      )
      return
    }
    if (cmd === '/cwd' || cmd === '#cwd') {
      await send(
        record,
        [`id：${record.sessionId}`, `目录：${record.dir || '(未隔离，仍用公共 cwd)'}`, `消息记录：${messageStats({ selfId, scope, peerId })}`].join(
          '\n',
        ),
      )
      return
    }
    if (cmd === '/help' || cmd === '#help') {
      await send(
        record,
        [
          '能用的命令：',
          '/reset 清空上下文重新开始',
          '/status 看看当前会话',
          '/cwd 看这个会话的目录',
          '/help 就是这份说明',
          ...(isGroup ? ['群聊命令必须在命令前 @我。'] : []),
        ].join('\n'),
      )
      return
    }

    // ── 图片：下载到本地，把路径交给 agent ──
    let imagePaths = []
    let classifierImages = [], classifierImageError = ''
    const imageSources = classified ? readMessage(event.message, { selfId }).images : info.images
    if (imageSources.length > 0) {
      await mkdir(cacheDir, { recursive: true }).catch(() => {})
      const prepared = await Promise.all(imageSources.slice(0, 4).map(async url => {
        let image
        try { image = await loadImage(url, maxMB) }
        catch (err) {
          if (classified) classifierImageError = String(err?.message ?? err)
          return {}
        }
        let path
        try {
          if (!policy.all && !blocksImage(image.data, policy)) {
            path = await cacheImage(image, cacheDir)
            attachments.add(path)
          }
        } catch (err) { logger.debug?.('图片未写入主会话缓存:', err?.message ?? err) }
        return { image, path }
      }))
      imagePaths = prepared.map(item => item.path).filter(Boolean)
      if (classified) classifierImages = prepared.filter(item => item.image).map(item => item.image.data)
      if (info.images.length > 0 && imagePaths.length === 0 && !policy.sizes.length) logger.warn?.(`[dsh-qq] 图片下载失败（${info.images.length} 张）`)
    }

    // ── 文件：下载到本地，把路径交给 agent ──
    let filePaths = []
    if (info.files.length > 0) {
      await mkdir(cacheDir, { recursive: true }).catch(() => {})
      for (const f of info.files.slice(0, 3)) {
        const src = f.url || f.file || ''
        if (!src) continue
        const p = await downloadImage(src, cacheDir, 64)
        if (p) {
          attachments.add(p)
          filePaths.push({ path: p, name: f.name || p.split(/[\\/]/).pop() })
        }
      }
      if (filePaths.length === 0) logger.warn?.(`[dsh-qq] 文件下载失败（${info.files.length} 个）`)
    }

    // ── 语音：转 wav → 本地 vosk 离线识别 ──
    let voiceTexts = []
    if (info.records.length > 0) {
      if (!config.asrEnabled) {
        voiceTexts.push('[语音]')
      } else {
        for (const rec of info.records.slice(0, 2)) {
          const file = rec.file || rec.path || ''
          if (!file) {
            voiceTexts.push('[语音，但拿不到文件]')
            continue
          }
          try {
            const res = await client.call('get_record', { file, out_format: 'wav' }, 20000)
            let wavPath = ''
            if (res?.file && /^[A-Za-z]:[\\/]/.test(String(res.file))) {
              wavPath = String(res.file)
            } else if (res?.base64) {
              await mkdir(cacheDir, { recursive: true }).catch(() => {})
              wavPath = join(cacheDir, `voice-${Date.now()}.wav`)
              await writeFile(wavPath, Buffer.from(String(res.base64), 'base64'))
            } else if (res?.url) {
              wavPath = (await downloadImage(String(res.url), cacheDir, 32)) || ''
            }
            if (!wavPath) {
              voiceTexts.push('[语音，转码失败]')
              continue
            }
            const text = await runAsr(config, wavPath)
            voiceTexts.push(text ? `[语音转文字] ${text}` : '[语音，没听清]')
          } catch (err) {
            logger.warn?.(`[dsh-qq] 语音识别失败: ${err?.message || err}`)
            voiceTexts.push('[语音，识别失败]')
          }
        }
      }
    }

    // ── 引用提示：让 agent 知道这句话在接谁的话（被引用的原文上面已经查过了，这里不再请求）──
    let quoteLine = ''
    if (info.replyId && config.quoteReply && client) {
      if (!quoteInfo || !quoteInfo.ok) {
        quoteLine = '[引用了一条消息，但没查到原文]'
      } else if (quoteInfo.userId === selfId) {
        quoteLine = `[引用 我自己：${quoteInfo.text}]`
      } else {
        quoteLine = `[引用 ${quoteInfo.name} (${quoteInfo.userId})：${quoteInfo.text}]`
      }
    }

    // ── 组装交给 agent 的那段文字 ──
    const parts = []
    // 当前时间：每条消息都带在最前面，跟着正文走 —— 会话压缩、历史被裁掉，这行也不会丢
    parts.push(`[收到消息的时间：${humanTime(new Date(event.__classifierReceivedAt ?? Date.now()))}]`)
    if (quoteLine) {
      parts.push(quoteLine, QUOTE_DIRECTION_HINT)
    }
    let head = info.text || ''
    if (isGroup || head) head = historyLine(sender, info.text || '[图片]', ownerInfo)
    if (head) parts.push(head)

    // 只保存本轮回复要求；沉默说明在请求末尾提供，不写入用户正文。
    const mustReply = mustReplyFor({
      isGroup,
      atMe: info.atMe,
      addressedMaySilent: config.addressedMaySilent,
    })

    if (imagePaths.length > 0) {
      parts.push(
        `[用户发了 ${imagePaths.length} 张图片，已存到本机，可以直接用 read_image 打开：]`,
        ...imagePaths.map((p) => `  ${p}`),
        IMAGE_RULES,
      )
      const hint = faceCollectRule(config)
      if (hint) parts.push(hint)
    } else if (info.images.length > 0 && !policy.sizes.length) {
      parts.push('[用户发了图片，但没能下载下来]')
    }

    if (voiceTexts.length > 0) parts.push(...voiceTexts)

    if (info.mfaces.length > 0) {
      // 顺手把表情包的身份证存进收藏夹，以后 qq_mface 就能拿来用
      const added = rememberFaces(config, info.mfaces)
      const total = facesCount(config)
      parts.push(
        '[对方发来表情包。表情包是说话的语气，不是让你鉴赏的画面——顺着这个情绪接话就好，不要描述图里画了什么，也不要问"这是谁"。]',
      )
      if (added > 0) parts.push(`[已顺手收进表情包收藏，现在一共 ${total} 个；想发就用 qq_mface，不填 id 会从收藏里随机挑一个。]`)
    }

    if (filePaths.length > 0) {
      parts.push(
        `[用户发了 ${filePaths.length} 个文件，已存到本机：]`,
        ...filePaths.map((f) => `  ${f.name} -> ${f.path}`),
      )
    }


    const body = parts.join('\n')
    {
      const session = classified ? record.agent.session : null
      const header = session?.requestHeader?.()
      const systemSnapshot = manager.systemPrompts?.get(record.sessionId)
      const meta = { selfId, scope, peerId, label }
      await addressClassifier.accept({
        id: event.__classifierId ?? (event.message_id == null ? randomUUID() : String(event.message_id)),
        meta,
        body, source: event, attachmentPaths: [...attachments],
        images: classifierImages, imageError: classifierImageError,
        robotName: manager.selfName || event.self_name || '机器人',
        mainContext: classified ? { header: systemSnapshot ? { ...header, system: systemSnapshot.text } : header,
          messages: session.deriveMessages(), runtimeContext: manager.runtimeContext?.(record) ?? '' } : undefined,
        background: [],
        message: { senderId, senderName, triggerText: readPlainText(event.message), text: info.text || '[非文字消息]',
          atMe: info.atMe, atOthers: info.atNames, quote: quoteInfo, time: event.time,
          voiceTranscripts: voiceTexts, imageCount: imageSources.length, fileNames: filePaths.map(f => f.name) },
      }, deliverBatch, { classify: classified })
      if (!config.addressClassifierEnabled) {
        if (isGroup) await scheduleGroup(meta)
        else await addressClassifier.resume(meta, deliverBatch, { classify: false })
      }
      return
    }

  }

  function permitted(meta) {
    const selfId = String(manager.selfId || config.selfId || '')
    return meta.selfId === selfId &&
      (meta.scope === 'group' ? allowGroup(config, meta.peerId) : allowPrivate(config, meta.peerId))
  }

  async function waitForTurn(record, meta) {
    const startedAt = Date.now()
    let notice
    const timer = setTimeout(() => {
      turnTimers.delete(timer)
      if (disposed || !permitted(meta)) return
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      logger.warn?.(`[dsh-qq] ${record.label} 本轮已跑 ${seconds}s 仍未结束，继续等待本轮结束`)
      notice = Promise.resolve().then(() => {
        if (!disposed && permitted(meta)) return send?.(record, `本轮已处理 ${seconds} 秒，仍在继续，请稍候。`)
      })
        .catch(error => logger.warn?.('发送单轮超时提示失败：', error.message))
    }, Number(config.maxTurnMs) || 600000)
    timer.unref?.()
    turnTimers.add(timer)
    try {
      await record.agent.whenIdle?.()
    } finally {
      clearTimeout(timer)
      turnTimers.delete(timer)
      await notice
    }
  }

  async function deliverBatch(range, meta) {
    if (disposed || !permitted(meta)) return false
    if (sleep?.shouldHold?.(manager.findByPeer?.(meta.scope, meta.peerId) ?? meta)) return false
    const record = await manager.obtain(meta)
    if (record.busy > 0) return false
    const isGroup = meta.scope === 'group', store = addressClassifier.store
    const latest = store.page(meta, { end: range.end, limit: 1 })[0]
    if (!latest) return false
    const mergeMs = Math.max(0, Number(config.mergeWindowMs ?? 5000))
    const version = syncTriggers()
    if (!isGroup && Date.now() - latest.receivedAt < mergeMs) {
      const key = JSON.stringify([meta.selfId, meta.scope, meta.peerId])
      clearTimeout(groupTimers.get(key))
      const timer = setTimeout(() => {
        groupTimers.delete(key)
        if (disposed || syncTriggers() !== version) return
        addressClassifier.resume(meta, deliverBatch, { classify: Boolean(config.addressClassifierEnabled) })
          .catch(error => logger.warn?.('处理合并私聊失败:', error))
      }, latest.receivedAt + mergeMs - Date.now())
      timer.unref?.()
      groupTimers.set(key, timer)
      return false
    }
    const signatureOf = () => JSON.stringify([range.end, version, record.sessionId, config.contextTokenizerFamily,
      config.provider, config.model, config.persona, config.chatPrompt, config.memoryProvider, config.memoryModel,
      manager.capacity?.fingerprint(record), manager.systemPrompts?.get(record.sessionId)?.at])
    const signature = signatureOf()
    if (store.blocked(meta)?.signature === signature) return false
    let settled = false
    return new Promise((resolve, reject) => {
      const settle = value => { if (!settled) { settled = true; resolve(value) } }
      manager.enqueue(record, async () => {
        let deliveryId, accepted = false
        try {
          await record.agent.whenIdle?.()
          if (disposed || !permitted(meta) || syncTriggers() !== version || sleep?.shouldHold?.(record)) return settle(false)
          if (record.agent.session?.snapshotEvents) store.recover(record)
          const render = (batch, omitted) => [
            '[现在是 ' + humanTime() + '；下面按收到的顺序提供此前未处理的消息。]',
            ...(omitted.length ? ['[容量限制：记录序号 ' + omitted[0] + ' 至 ' + omitted.at(-1) + ' 中有 ' + omitted.length + ' 条旧消息未提供，不代表已经读过。原文可通过 qq_history 按本聊天权限回查。]'] : []),
            ...batch.map(item => item.body),
          ].join('\n\n')
          const notices = [sleep?.takeLateBedtime?.(record), ...(bridge?.take?.(record) ?? [])].filter(Boolean)
          const renderInput = (batch, omitted) => [...notices, render(batch, omitted)].join('\n\n')
          const plan = manager.capacity ? await manager.capacity.select(record, manager, store, range.end, renderInput)
            : { selected: range.read(), omitted: [], body: renderInput(range.read(), []) }
          const batch = plan.selected
          if (!batch.length || disposed || syncTriggers() !== version || !permitted(meta)) return settle(false)
          if (batch.some(item => isPeerBot(config, item.source?.user_id, item.source) && !config.botChatEnabled)) return settle(false)
          if (isGroup && requiresGroupMention(config, meta.peerId) && !batch.some(item => item.message.atMe &&
            (!config.addressClassifierEnabled || item.decision === 'yes'))) return settle(false)
          const last = batch.at(-1), peerBot = isPeerBot(config, last.source?.user_id, last.source)
          const maxTurns = Number(config.peerChatMaxTurns) || 0
          const prev = peerChatTurns.get(meta.peerId)
          if (peerBot && maxTurns > 0 && prev && Date.now() - prev.at < PEER_CHAT_TURN_WINDOW_MS && prev.count >= maxTurns) return settle(false)
          record.lastSenderId = Number(last.source?.user_id) || null
          record.lastSenderName = last.message.senderName
          record.lastMessageId = Number(last.source?.message_id) || null
          record.lastMessageAt = Date.now()
          record.label = meta.label
          deliveryId = store.begin(meta, record.sessionId, batch, plan.omitted)
          const mustReply = batch.some(({ message }) => mustReplyFor({ isGroup, atMe: message.atMe, addressedMaySilent: config.addressedMaySilent }))
          const message = createUserMessage({ content: [{ type: 'text', text: plan.body }], source: {
            kind: 'user', qqMaySilent: !mustReply, qqDeliveryId: deliveryId,
            qqMessages: batch.map(item => ({ id: item.id, seq: item.seq })),
          } })
          record.activeDeliveryId = deliveryId
          record.agent.followup(message)
          accepted = true
          store.finish(deliveryId, 'admitted', { tokens: plan.tokens, limit: plan.limit })
          wake?.noteInbound?.(record)
          if (peerBot) {
            const now = Date.now()
            const count = prev && now - prev.at < PEER_CHAT_TURN_WINDOW_MS ? prev.count + 1 : 1
            peerChatTurns.set(meta.peerId, { count, at: now })
          }
          for (const item of batch) {
            const line = historyLine(item.source?.sender ?? {}, item.message.text, identityOf(item.message.senderId))
            if (isGroup) pushHistory(record, line)
            record.recent.push(line.slice(0, 2000))
          }
          record.recent = record.recent.slice(-200)
          sleep?.noteText?.(record, last.message.text, new Date(last.receivedAt))
          // 允许后续分类继续；同聊天的主轮仍由 enqueue 持有直到实际结束。
          settle(true)
          await waitForTurn(record, meta)
          await record.outputQueue
          const events = record.agent.session?.snapshotEvents?.() ?? []
          const end = events.findLast(event => event.type === 'turn/end')
          if (end) {
            store.finish(deliveryId, end.data.reason?.kind === 'completed' ? 'processed' : 'failed', { reason: end.data.reason })
            if (end.data.reason?.kind !== 'completed' && !disposed && JSON.stringify(end.data.reason).includes('输入容量检查失败')) {
              await send?.(record, '本轮输入超过模型容量，消息和工具结果已保留，不会自动重新执行。可用 /status 查看记录。')
            }
          }
        } catch (error) {
          if (!deliveryId) {
            store.block(meta, signatureOf(), error.message)
            if (!disposed) await send?.(record, '本轮消息处理停止，原文已保留。原因：' + error.message + '。修改相关设置、新建会话或收到新消息后再尝试。')
          }
          if (deliveryId) {
            // 接纳后的失败不能重新追加；未接纳范围可以继续正常投递。
            try {
              if (!accepted && record.agent.session?.snapshotEvents) store.recover(record)
              else store.finish(deliveryId, 'failed', { error: error.message })
            }
            catch (saveError) { logger.warn?.('保存消息处理结果失败，等待会话证据恢复：', saveError.message) }
          }
          logger.warn?.('消息处理失败，原文和会话保留：', error.message)
          if (!settled) { settled = true; reject(error) }
        } finally {
          delete record.activeDeliveryId
          settle(false)
        }
      }).catch(error => { if (!settled) { settled = true; reject(error) } })
    })
  }

  // 配置变化后废弃旧等待；回调执行前再次核对，避免旧定时器绕过新设置。
  function syncTriggers() {
    const version = JSON.stringify([manager.selfId || config.selfId, config.requireMention,
      config.groupMentionOverrides, config.groupMessageIntervalMs, config.groupTriggerWords, config.addressClassifierEnabled,
      config.groupMode, config.groupAllow, config.botChatEnabled, config.peerBots, config.mergeWindowMs])
    if (version !== triggerVersion) {
      for (const timer of groupTimers.values()) clearTimeout(timer)
      groupTimers.clear()
      triggerVersion = version
    }
    return version
  }

  async function scheduleGroup(meta) {
    const version = syncTriggers()
    if (disposed || config.addressClassifierEnabled || !permitted(meta)) return
    const key = JSON.stringify([meta.selfId, meta.scope, meta.peerId])
    const pending = addressClassifier.summary(meta)
    if (!pending || pending.unprepared) return
    const mentioned = pending.mentioned
    if (requiresGroupMention(config, meta.peerId) && !mentioned) return
    const immediate = mentioned || addressClassifier.store.hasTrigger(meta, listOf(config.groupTriggerWords))
    if (groupTimers.has(key)) {
      if (!immediate) return
      clearTimeout(groupTimers.get(key))
      groupTimers.delete(key)
    }
    const due = immediate ? Date.now() : pending.first.receivedAt + groupMessageInterval(config)
    if (due <= Date.now()) return addressClassifier.resume(meta, deliverBatch, { classify: false })
    const timer = setTimeout(async () => {
      groupTimers.delete(key)
      if (disposed || syncTriggers() !== version || config.addressClassifierEnabled) return
      try { await addressClassifier.resume(meta, deliverBatch, { classify: false }) }
      catch (err) { logger.warn?.('处理待交付群消息失败:', err) }
    }, Math.max(0, due - Date.now()))
    timer.unref?.()
    groupTimers.set(key, timer)
  }

  const onEvent = async event => {
    if (disposed) return
    syncTriggers()
    if (event?.post_type !== 'message') return handleEvent(event)
    const scope = event.message_type === 'group' ? 'group' : 'private'
    const selfId = String(event.self_id ?? manager.selfId ?? '')
    const peerId = String(scope === 'group' ? event.group_id : event.user_id)
    const key = JSON.stringify([selfId, scope, peerId])
    // 审批/问答走控制通道，不等待正在执行的分类请求。
    if (event?.post_type === 'message') {
      const scope = event.message_type === 'group' ? 'group' : 'private'
      const peerId = String(scope === 'group' ? event.group_id : event.user_id)
      const selfId = String(event.self_id ?? manager.selfId ?? '')
      const allowed = scope === 'group' ? allowGroup(config, peerId) : allowPrivate(config, peerId)
      const eventKey = event.message_id == null ? null : JSON.stringify([selfId, scope, peerId, String(event.message_id)])
      if (!event.__classifierRecovery && eventKey && (seenMessages.get(eventKey) ?? 0) > Date.now()) return
      const botAllowed = !isPeerBot(config, event.user_id, event) || config.botChatEnabled
      const record = allowed && botAllowed && String(event.user_id) !== selfId && manager.findByPeer?.(scope, peerId)
      const text = record && readMessage(event.message, { selfId }).text?.trim()
      if (text && (approval?.tryResolve?.(record, text) || questions?.tryResolve?.(record, text))) {
        if (eventKey) seenMessages.set(eventKey, Date.now() + 10 * 60_000)
        return Promise.resolve()
      }
      // 控制命令不等待同聊天的分类请求或普通消息等待。
      if (allowed && botAllowed && commandOf(event.message, selfId, scope === 'group')) return handleEvent(event)
    }
    const meta = { selfId, scope, peerId, label: scope === 'group' ? `群 ${peerId}` : `私聊 ${peerId}` }
    let sourceKey, sourceId
    if (event?.post_type === 'message' && String(event.user_id) !== selfId && permitted(meta) &&
      (!isPeerBot(config, event.user_id, event) || config.botChatEnabled)) {
      const info = readMessage(event.message, { selfId })
      const control = Boolean(commandOf(event.message, selfId, scope === 'group'))
      if (!control && (info.text || info.images.length || info.records.length || info.files.length || info.mfaces.length || info.forwards.length)) {
        if (!event.__classifierRecovery && !ingressQueues.has(key)) {
          for (const item of addressClassifier.unprepared(meta)) {
            onEvent({ ...item.source, __classifierId: item.id, __classifierRecovery: true })
              .catch(err => logger.warn?.('恢复源消息失败:', err))
          }
        }
        sourceId = String(event.__classifierId ?? event.message_id ?? randomUUID())
        sourceKey = JSON.stringify([key, sourceId])
        if (preparingSources.has(sourceKey)) return
        event = { ...event, __classifierId: sourceId,
          __classifierReceivedAt: event.__classifierReceivedAt ?? Date.now() }
        if (!addressClassifier.stage({ meta, id: sourceId, source: event })) return
        preparingSources.add(sourceKey)
      }
    }
    const task = (ingressQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const result = await handleEvent(event)
      if (sourceKey && !disposed && permitted(meta)) addressClassifier.discardUnprepared(meta, sourceId)
      return result
    }).finally(() => { if (sourceKey) preparingSources.delete(sourceKey) })
    ingressQueues.set(key, task)
    task.finally(() => { if (ingressQueues.get(key) === task) ingressQueues.delete(key) }).catch(() => {})
    return task
  }
  const resumeTimer = setInterval(() => {
    if (disposed) return
    syncTriggers()
    try {
      for (const meta of addressClassifier.pendingChats()) {
        if (!permitted(meta)) continue
        const key = JSON.stringify([meta.selfId, meta.scope, meta.peerId])
        if (!ingressQueues.has(key)) {
          for (const item of addressClassifier.unprepared(meta)) {
            onEvent({ ...item.source, __classifierId: item.id, __classifierRecovery: true })
              .catch(err => logger.warn?.('恢复源消息失败:', err))
          }
        }
        const resume = async () => {
          if (sleep?.shouldHold?.(manager.findByPeer?.(meta.scope, meta.peerId) ?? meta)) return
          const record = manager.findByPeer?.(meta.scope, meta.peerId) ??
            (!addressClassifier.summary(meta) ? await manager.obtain(meta) : null)
          if (record && !record.busy && record.agent.session?.snapshotEvents) addressClassifier.store.recover(record)
          if (config.addressClassifierEnabled) return addressClassifier.resume(meta, deliverBatch)
          if (meta.scope === 'group') return scheduleGroup(meta)
          return addressClassifier.resume(meta, deliverBatch, { classify: false })
        }
        resume().catch(err => logger.warn?.('恢复待交付消息失败:', err))
      }
    } catch (err) {
      logger.warn?.('读取待回复消息失败:', err)
    }
  }, 1000)
  resumeTimer?.unref?.()
  onEvent.dispose = () => {
    disposed = true
    if (resumeTimer) clearInterval(resumeTimer)
    addressClassifier?.stop()
    for (const timer of groupTimers.values()) clearTimeout(timer)
    groupTimers.clear()
    for (const timer of turnTimers) clearTimeout(timer)
    turnTimers.clear()
    seenMessages.clear()
  }
  return onEvent
}
