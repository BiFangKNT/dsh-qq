/**
 * 给 agent 的「手」：在 QQ 里做点小动作。
 *
 * 这些工具只在 dsh-qq 的会话里才有意义，所以由插件自己注册；
 * 别的通道的同名工具不会冲突（统一 `qq_` 前缀）。
 *
 * 全部通过 `ctx.get('tools')` 注册，tools 服务不存在时安静跳过，
 * 不让插件因为缺服务而启动失败。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { pickFace, keepFace, facesCount, faceSendState, markFaceSent, listFaces } from './faces.js'
import { homeDirOf } from './settings.js'
import { checkOutboundText, SensitiveContentError } from './audit.js'
import { downloadImage } from './inbound.js'
import { cleanOutboundText } from './shared/outbound-text.js'
import { registerExtraTools } from './tools-extra.js'
import { registerMemoryTool } from './memory-tools.js'
import { registerMessageTool } from './message-tools.js'
import { createKnowledge } from './knowledge.js'
import { registerKnowledgeTools } from './knowledge-tools.js'
import { resolveSendTarget, assertSendAccess, parseMessageId } from './tool-send.js'
import { readChatMessage } from './message-access.js'
import { createToolPolicy } from './tool-policy.js'
import { parseCQString } from './onebot/segment.js'
import { callToolAction, sendToolMessage, EXTERNAL_ACTION_RULE, fitToolText, jsonSize, TOOL_RESULT_LIMIT } from './tool-result.js'

const POKE_DESC =
  '戳一戳当前对话里的对方（私聊戳好友，群聊戳那位发言的人）。用来提醒对方注意、' +
  '或者轻轻催一下，属于 QQ 特有的互动。不要连续戳超过两次。'

const REACT_DESC =
  '给当前对话里最新的一条消息贴上表情回应（QQ 的「表情表态」）。' +
  '消息必须可确认属于当前聊天；不能操作其他聊天的消息。' +
  '表情 id 用 QQ 表情的数字编号，比如 1 是微笑、4 是得意、14 是白眼、178 是捂脸、' +
  '212 是裂开、264 是流泪。想表达态度又不想刷屏时用它。'

const IMAGES_DESC =
  '把某条 QQ 消息里的图片重新取回来看（按消息 id）。' +
  '仅限可确认属于当前聊天的消息，无法确认归属时失败。' +
  '消息正文里只会出现一个 `[图片]` 占位——那一刻没被叫醒、或者当时没顾上看，' +
  '事后用这个工具还能把那张图捞回来。' +
  '聊天流水里每行末尾有 `#msg=123456`，那就是这条消息的 id；不填 id 就是最近收到的这一条。' +
  '返回本机文件路径，用 read_image 打开。每次最多四张；nextOffset非空时用offset继续取图，failed列出本批下载失败的序号（从0开始）。无图片是正常结果。'

const LIKE_DESC =
  '给对方的 QQ 名片点赞（就是资料页的那个赞）。每天每人最多 10 次，' +
  '一般是表达鼓励或者「我看到你了」。'

const IMAGE_DESC =
  '把本地的一张图片发到当前 QQ 对话里。file 传绝对路径或电脑上的文件名。' +
  '发之前确认文件确实存在，别传不存在的路径。'

const RECALL_DESC =
  '撤回自己在当前对话里刚发出的一条消息。QQ 只允许撤回两分钟内的消息，超过就会失败。'

const FACE_DESC =
  '在 QQ 里发一个内置小表情（QQ 自带的黄脸表情），不是文字，也不是图片。' +
  'id 用 QQ 表情编号，常用：1 微笑、4 得意、14 白眼、101 嘘、178 捂脸、182 笑哭、212 裂开、264 流泪。'

const FILE_DESC =
  '把一个本地文件发到当前 QQ 对话里（对方能点开下载）。file 传电脑上的绝对路径，' +
  'name 可选，不填就用原文件名。只发确实存在的文件。'

/** 从工具执行上下文里找到对应的 QQ 会话记录。 */
function recordOf(manager, exec) {
  const session = exec?.agent?.session
  const id = session?.header?.id ?? session?.id
  if (id === undefined || id === null) return null
  return manager.find(String(id))
}

function needRecord(manager, exec) {
  const record = recordOf(manager, exec)
  if (!record) throw new Error('这个工具只能在 QQ 会话里用（找不到对应的 QQ 会话记录）')
  return record
}

function peerOf(record) {
  return record.scope === 'group'
    ? { group_id: Number(record.peerId) }
    : { user_id: Number(record.peerId) }
}

export function registerTools(ctx, { client, manager, config, logger, wake, noteSelfSaid, home, knowledge, notifyBlocked, synthesize, platform }) {
  const registry = ctx.get?.('tools')
  if (!registry?.register) {
    logger.info?.('tools 服务不可用，QQ 互动工具未注册（聊天本身不受影响）')
    return
  }
  knowledge ??= createKnowledge({ home: home ?? homeDirOf(ctx, logger), logger })
  const policy = createToolPolicy({ config, manager, knowledge, platform })
  const registered = []
  const tools = { register: definition => {
    const dispose = policy.register(registry, definition)
    registered.push(definition.name)
    return dispose
  } }

  /**
   * 工具发出去的东西也要记账（2026-10-27 姐姐让修的）。
   *
   * 以前只有正文走 send() 才写流水、进 history，用 qq_send 说的话等于「发出去就没了」：
   * 翻聊天记录缺一句，下一轮她自己也不知道自己说过。这里补上，顺带兑现主动开口的额度。
   */
  function noteToolSent(record, text, target = record, messageId = null) {
    const said = String(text ?? '').trim()
    if (!said) return
    const destination = target.scope === record.scope && String(target.peerId) === String(record.peerId)
      ? record : manager.findByPeer?.(target.scope, target.peerId)
    // 尚无会话的目标已由 OneBot 出口记录到 SQLite，不为记账启动 Agent。
    if (!destination) return
    if (messageId !== null) destination.lastSentMessageId = messageId
    try {
      wake?.noteOutbound?.(destination)
      if (destination === record) wake?.noteProactiveDelivered?.(destination)
      noteSelfSaid?.(destination, said)
      manager.memory?.noteSent(destination, said, messageId)
    } catch (err) {
      logger?.debug?.(`工具外发记账失败：${err?.message ?? err}`)
    }
  }

  registerMemoryTool(tools, manager)
  registerMessageTool(tools, manager, config)

  async function assertOutboundText(text, record, source) {
    const verdict = checkOutboundText(text, { config, logger, record, source, knownSecrets: [client.token] })
    if (verdict.ok) {
      policy.assertAvailable(source, record)
      return
    }
    await notifyBlocked?.(record)
    throw new SensitiveContentError(verdict.rule)
  }

  registerKnowledgeTools(tools, { knowledge, config, manager, needRecord })

  tools.register({
    name: 'qq_poke',
    description: POKE_DESC + EXTERNAL_ACTION_RULE,
    parameters: {
      type: 'object',
      properties: {
        user_id: {
          type: 'integer',
          description: '可选：群里要戳谁（不填就是当前发言的人）。私聊不用填。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, target: { type: 'string' } },
        required: ['ok', 'target'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `戳了戳 ${value.target}` },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const targetUser = Number(args?.user_id ?? record.lastSenderId ?? 0)
      if (!Number.isFinite(targetUser) || targetUser <= 0) {
        throw new Error('qq_poke: 不知道要戳谁（拿不到对方的 QQ 号）')
      }
      if (record.scope === 'group') {
        await callToolAction(client, 'group_poke', { group_id: Number(record.peerId), user_id: targetUser }, logger)
      } else {
        await callToolAction(client, 'friend_poke', { user_id: targetUser }, logger)
      }
      return { ok: true, target: String(targetUser) }
    },
  })

  tools.register({
    name: 'qq_react',
    description: REACT_DESC + EXTERNAL_ACTION_RULE,
    parameters: {
      type: 'object',
      properties: {
        emoji_id: { type: 'string', description: 'QQ 表情编号，例如 "178"（捂脸）' },
        message_id: { type: 'integer', description: '可选：要表态的消息 id，默认最新一条' },
      },
      required: ['emoji_id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, messageId: { type: 'integer' } },
        required: ['ok', 'messageId'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `给消息 ${value.messageId} 贴了表情` },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const messageId = parseMessageId(args?.message_id ?? record.lastMessageId)
      if (messageId === null) {
        throw new Error('qq_react: 找不到可表态的消息')
      }
      await readChatMessage({ client, manager, config, record, messageId, logger })
      policy.assertAvailable('qq_react', record)
      await callToolAction(client, 'set_msg_emoji_like', {
        message_id: messageId,
        emoji_id: String(args.emoji_id),
        set: true,
      }, logger)
      return { ok: true, messageId }
    },
  })

  tools.register({
    name: 'qq_images',
    description: IMAGES_DESC,
    parameters: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, description: '图片序号，默认0；续读取nextOffset' },
        message_id: {
          type: 'integer',
          description: '可选：要看哪条消息里的图（流水里 `#msg=` 后面那串）。不填就是最近收到的这一条。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          messageId: { type: 'integer' },
          paths: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
          partial: { type: 'boolean' }, total: { type: 'integer' },
          nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }] }, failed: { type: 'array', items: { type: 'integer' } },
        },
        required: ['ok', 'messageId', 'paths', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const messageId = parseMessageId(args?.message_id ?? record.lastMessageId)
      if (messageId === null) {
        throw new Error('qq_images: 不知道要看哪条消息')
      }

      const offset = args.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('图片位置无效')
      let data
      try {
        data = await readChatMessage({ client, manager, config, record, messageId, logger })
      } catch (err) {
        logger.warn?.(`qq_images 取消息失败: ${err?.message ?? err}`)
        throw new Error(`取消息失败：${err?.message ?? err}`, { cause: err })
      }

      const message = data?.message ?? data?.data?.message
      if (!Array.isArray(message) && typeof message !== 'string') throw new Error('消息回执缺少正文')
      const segs = Array.isArray(message) ? message : parseCQString(message)
      const urls = []
      for (const seg of segs) {
        if (seg?.type !== 'image') continue
        const d = seg.data ?? {}
        const src = String(d.url ?? '') || String(d.file ?? '') || String(d.path ?? '')
        if (src) urls.push(src)
      }
      if (urls.length === 0) {
        return {
          ok: true,
          messageId,
          paths: [],
          message: '无图片', total: 0, partial: false, nextOffset: null, failed: [],
        }
      }

      if (offset >= urls.length) throw new Error('图片位置无效')
      const cacheDir = record.dir
        ? join(record.dir, '图片缓存')
        : join(String(config?.cwd ?? '').trim() || process.cwd(), '图片缓存')
      await mkdir(cacheDir, { recursive: true }).catch(() => {})
      const maxMB = Number(config?.imageMaxMB) || 8
      const downloaded = await Promise.all(urls.slice(offset, offset + 4).map(u => downloadImage(u, cacheDir, maxMB)))
      policy.assertAvailable('qq_images', record)
      const paths = downloaded.filter(Boolean)
      if (!paths.length) throw new Error('图片下载失败：链接可能已过期')
      const failed = downloaded.flatMap((value, index) => value ? [] : [offset + index])
      const nextOffset = offset + downloaded.length < urls.length ? offset + downloaded.length : null
      return { ok: true, messageId, paths, message: '', total: urls.length,
        partial: failed.length > 0 || nextOffset !== null, nextOffset, failed }
    },
  })

  tools.register({
    name: 'qq_like',
    description: LIKE_DESC + EXTERNAL_ACTION_RULE,
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'integer', description: '给谁点赞，不填就是当前对话的对方' },
        times: { type: 'integer', description: '点几次，1-10，默认 1' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, target: { type: 'string' } },
        required: ['ok', 'target'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `给 ${value.target} 点了赞` },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const target = Number(args?.user_id ?? record.lastSenderId ?? 0)
      const times = Math.min(Math.max(Number(args?.times ?? 1) || 1, 1), 10)
      if (!Number.isFinite(target) || target <= 0) {
        throw new Error('qq_like: 不知道给谁点赞')
      }
      await callToolAction(client, 'send_like', { user_id: target, times }, logger)
      return { ok: true, target: String(target) }
    },
  })

  tools.register({
    name: 'qq_send_image',
    description: IMAGE_DESC + EXTERNAL_ACTION_RULE,
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '图片的绝对路径，或 QQ 能识别的文件名' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, target: { type: 'string' } },
        required: ['ok', 'target'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `图片已发到 ${value.target}`,
        },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const file = String(args?.file ?? '').trim()
      if (!file) throw new Error('qq_send_image: file 不能为空')
      // 图片也算「发图」，跟表情包共用同一个节奏闸
      const gate = faceSendState(config)
      if (!gate.allowed) throw new Error(gate.reason)
      const action = record.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
      const messageId = await sendToolMessage(client, action, { ...peerOf(record), message: [{ type: 'image', data: { file } }] }, logger, { record, text: '[图片]' })
      markFaceSent()
      noteToolSent(record, '[图片]', record, messageId)
      return { ok: true, target: record.label }
    },
  })

  tools.register({
    name: 'qq_face',
    description: FACE_DESC + EXTERNAL_ACTION_RULE,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'QQ 内置表情编号，例如 "178"（捂脸）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, id: { type: 'string' } },
        required: ['ok', 'id'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `发了个表情 ${value.id}` },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const id = String(args?.id ?? '').trim()
      if (!id) throw new Error('qq_face: id 不能为空')
      const action = record.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
      const messageId = await sendToolMessage(client, action, { ...peerOf(record), message: [{ type: 'face', data: { id } }] }, logger, { record, text: `[表情 ${id}]` })
      noteToolSent(record, `[表情 ${id}]`, record, messageId)
      return { ok: true, id }
    },
  })

  tools.register({
    name: 'qq_send_file',
    description: FILE_DESC + EXTERNAL_ACTION_RULE,
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '要发送文件的绝对路径' },
        name: { type: 'string', description: '可选：对方看到的文件名' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, target: { type: 'string' } },
        required: ['ok', 'target'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `文件已发到 ${value.target}` },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const file = String(args?.file ?? '').trim()
      if (!file) throw new Error('qq_send_file: file 不能为空')
      const name = String(args?.name ?? '').trim() || file.split(/[\\/]/).pop()
      await callToolAction(client, record.scope === 'group' ? 'upload_group_file' : 'upload_private_file', {
        ...peerOf(record), file, name,
      }, logger, { record, text: `[文件] ${name}` })
      noteToolSent(record, `[文件] ${name}`)
      return { ok: true, target: record.label }
    },
  })

  tools.register({
    name: 'qq_recall',
    description: RECALL_DESC + EXTERNAL_ACTION_RULE,
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'integer', description: '要撤回的消息 id，不填就是自己刚发的那条' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, messageId: { type: 'integer' } },
        required: ['ok', 'messageId'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `已撤回消息 ${value.messageId}` },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const messageId = parseMessageId(args?.message_id ?? record.lastSentMessageId)
      if (messageId === null) {
        throw new Error('qq_recall: 找不到要撤回的消息')
      }
      await readChatMessage({ client, manager, config, record, messageId, own: true, logger })
      await callToolAction(client, 'delete_msg', { message_id: messageId }, logger)
      return { ok: true, messageId }
    },
  })

  tools.register({
    name: 'qq_send',
    description:
      '发送文字；可用 message_id 引用目标聊天中的消息。普通回复直接输出正文即可。' +
      '不填 to 就发给「当前正在跟你说话的人/群」；' +
      'to 可指定 `user:<QQ号>` 或 `group:<群号>`；跨聊天发送仅授权账号私聊可用，当前聊天和目标均须获准。' +
      '引用消息须经聊天记录或协议端确认属于目标聊天；无法确认时不发送。' + EXTERNAL_ACTION_RULE,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发的正文' },
        to: { type: 'string', description: '可选：`user:<QQ号>` 或 `group:<群号>`；不填=当前会话' },
        message_id: { type: 'integer', description: '可选：目标聊天内要引用的消息 ID；省略则普通发送' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          messageId: { type: 'integer' },
          target: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `已发到 ${value.target}` },
      ],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const destination = resolveSendTarget(record, args?.to)
      assertSendAccess(manager, config, record, destination)
      const quoted = args?.message_id === undefined ? null : parseMessageId(args.message_id)
      if (args?.message_id !== undefined && quoted === null) throw new Error('message_id 必须为有效整数')
      const text = cleanOutboundText(args?.text)
      if (!text) throw new Error('qq_send: text 不能为空')
      await assertOutboundText(text, record, 'qq_send')
      if (quoted !== null && !manager.messageStore?.hasMessage(destination, quoted)) {
        await readChatMessage({ client, manager, config, record: destination, messageId: quoted, logger })
      }
      assertSendAccess(manager, config, record, destination)
      const action = destination.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
      const target = peerOf(destination)
      const targetLabel = `${destination.scope === 'group' ? 'group' : 'user'}:${destination.peerId}`

      const sentId = await sendToolMessage(client, action, {
        ...target,
        message: [...(quoted === null ? [] : [{ type: 'reply', data: { id: String(quoted) } }]), { type: 'text', data: { text } }],
      }, logger, { record, target: destination, text })
      noteToolSent(record, text, destination, sentId)
      return { ok: true, messageId: sentId, target: targetLabel }
    },
  })

  tools.register({
    name: 'qq_keep_face',
    description:
      '把本地普通图片复制到表情收藏并登记名称。mode=requested 仅用于用户明确要求收藏；mode=automatic 须符合末尾状态区的自动收藏规则。' +
      '规则留空时禁止自动收藏，但允许用户明确要求的收藏。先查看图片，按实际内容命名。商城表情由程序自动登记，不用本工具。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地图片的绝对路径' },
        mode: { type: 'string', enum: ['requested', 'automatic'], description: 'requested：用户明确要求；automatic：按已配置规则自动收藏' },
        summary: {
          type: 'string',
          description:
            '给这张起的名字，以后靠它挑图。图上有大字就用那行字，越短越好（「哼！」「求求了…」「下次见！」）；' +
            '没字就一句话说清画面和情绪（「抱着白饭碗干饭」「抱着小人偶一脸问号」）。',
        },
      },
      required: ['path', 'mode'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          added: { type: 'boolean' },
          total: { type: 'integer' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      if (!['requested', 'automatic'].includes(args?.mode)) throw new Error('请说明收藏来源：requested（用户明确要求）或 automatic（按自动收藏规则）')
      if (args.mode === 'automatic' && !String(config.faceCollectHint ?? '').trim()) throw new Error('未设置普通图片自动收藏规则，只能按用户明确要求收藏')
      const result = keepFace(config, { path: args?.path, summary: args?.summary })
      if (!result.ok) {
        logger.warn?.(`qq_keep_face 失败：${result.reason}`)
        throw new Error(existsSync(String(args.path)) ? '收藏写入失败' : '收藏文件不存在')
      }
      return { ok: true, added: result.added, total: result.total }
    },
  })

  tools.register({
    name: 'qq_faces',
    description: '查询表情收藏名称。total 是全部收藏数，unnamed 是无名称数，matched 是关键词命中的有名称数；空收藏或无命中是正常结果。最多返回50个名称，完整JSON最多12000字符。partial=true 时保持keyword，携带next中的offset、textOffset和snapshot续读；textOffset非零时names第一项是上个名称的后续文字，拼接后才是完整名称。收藏变化导致STALE_PAGE时从头查询。',
    parameters: { type: 'object', properties: {
      keyword: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, textOffset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 50 }, snapshot: { type: 'string' },
    }, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      const all = listFaces(config, Number.MAX_SAFE_INTEGER)
      const kw = String(args?.keyword ?? '').trim()
      const named = all.map(f => String(f.summary ?? '').trim()).filter(Boolean)
      const names = named.filter(n => !kw || n.includes(kw))
      const snapshot = createHash('sha256').update(JSON.stringify([kw, all])).digest('hex')
      const offset = args.offset ?? 0, textOffset = args.textOffset ?? 0, limit = args.limit ?? 50
      if (![offset, textOffset, limit].every(Number.isSafeInteger) || offset < 0 || offset > names.length || textOffset < 0 || limit < 1 || limit > 50 ||
        textOffset && offset === names.length) throw new Error('分页参数无效')
      if ((offset || textOffset) && args.snapshot !== snapshot || args.snapshot !== undefined && args.snapshot !== snapshot) throw new Error('STALE_PAGE')
      let result = { ok: true, total: all.length, unnamed: all.length - named.length, matched: names.length,
        offset, textOffset, snapshot, names: [], partial: false, next: null }
      for (let index = offset; index < names.length && result.names.length < limit; index++) {
        const from = index === offset ? textOffset : 0
        const build = (text, end) => {
          const nextIndex = end < names[index].length ? index : index + 1
          const next = nextIndex < names.length ? { offset: nextIndex, textOffset: end < names[index].length ? end : 0, snapshot } : null
          return { ...result, names: [...result.names, text], partial: next !== null, next }
        }
        if (result.names.length && jsonSize(build(names[index].slice(from), names[index].length)) > TOOL_RESULT_LIMIT) break
        result = fitToolText(names[index], from, build)
        if (result.next?.textOffset) break
      }
      return result
    },
  })

  tools.register({
    name: 'qq_mface',
    description: '发送收藏图片或 QQ 商城表情。summary 按 qq_faces 返回的名称选择，留空随机；也可用 emoji_id、emoji_package_id、key 指定商城表情。按话题和语气选择，一次一张，不必每条回复配图，不代替必要的文字解释。受图片发送间隔和每小时限额限制，被拒绝后不重复尝试；不会自动改用 CDN 重发。' + EXTERNAL_ACTION_RULE,
    parameters: { type: 'object', properties: {
      emoji_id: { type: 'string' }, emoji_package_id: { type: 'string' }, key: { type: 'string' },
      summary: { type: 'string', description: '收藏名称；省略则随机选择' },
    }, additionalProperties: false },
    output: { schema: { type: 'object', properties: {
      ok: { type: 'boolean' }, mode: { type: 'string' }, messageId: { type: 'integer' },
    }, required: ['ok', 'mode', 'messageId'], additionalProperties: false },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const gate = faceSendState(config)
      if (!gate.allowed) throw new Error(gate.reason)
      const explicit = String(args?.emoji_id ?? '').trim()
      const face = explicit ? { kind: 'mface', emojiId: explicit, packageId: String(args?.emoji_package_id ?? '').trim(),
        key: String(args?.key ?? '').trim(), summary: String(args?.summary ?? '').trim() } : pickFace(config, args?.summary)
      if (!face) throw new Error('收藏为空')
      if (face.kind === 'image' && !existsSync(face.path)) throw new Error('收藏图片不存在')
      const segment = face.kind === 'image' ? { type: 'image', data: { file: face.path } } : {
        type: 'mface', data: { emoji_id: face.emojiId, emoji_package_id: face.packageId || '1',
          key: face.key || face.emojiId, summary: face.summary || '[表情]' },
      }
      const messageId = await sendToolMessage(client, record.scope === 'group' ? 'send_group_msg' : 'send_private_msg', {
        ...peerOf(record), message: [segment],
      }, logger, { record, text: `[表情包] ${face.summary || '图片'}` })
      markFaceSent()
      noteToolSent(record, `[表情包] ${face.summary || '图片'}`, record, messageId)
      return { ok: true, mode: face.kind, messageId }
    },
  })

  registerExtraTools(tools, {
    client, manager, config, home: home ?? homeDirOf(ctx, logger),
    needRecord, assertText: assertOutboundText, noteToolSent, synthesize, assertAvailable: policy.assertAvailable, logger,
  })

  logger.info?.(
    `QQ 工具已注册（按当前聊天、开关和运行条件提供）：${registered.join(' / ')}（表情包收藏 ${facesCount(config)} 个）`,
  )
}
