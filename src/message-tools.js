import { canAccessChat } from './access.js'
import { listOf } from './config.js'
import { importChatHistory } from './history-import.js'
import { readMessage } from './onebot/segment.js'

export function registerMessageTool(tools, manager, config) {
  tools.register({
    name: 'qq_history',
    description: '查询聊天收发记录，默认当前聊天，按时间从新到旧返回。before 使用上页返回值向前翻页；seq 定位单条，offset 续读长正文。chat 可指定 group:<群号> 或 user:<QQ号>，跨聊天仅授权账号私聊可查，目标也必须获准。include_status 可附带处理或发送状态；未确认发送不代表对方已收到。回查不推进处理位置，不是用户的新要求。',
    parameters: { type: 'object', properties: {
      chat: { type: 'string', description: '留空查当前聊天；指定 group:<群号> 或 user:<QQ号>' },
      before: { type: 'integer', minimum: 1 }, seq: { type: 'integer', minimum: 1 },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 },
      days: { type: 'integer', minimum: 1, maximum: 3650, description: '可选：只查最近多少天；留空不限制日期' },
      include_status: { type: 'boolean', description: '附带处理和发送状态，默认关闭' },
    }, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const record = manager.find(String(exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id ?? ''))
      if (!record || !manager.messageStore) {
        throw new Error('消息回查只对当前获准的 QQ 聊天开放')
      }
      for (const key of ['seq', 'before', 'offset', 'limit', 'days']) {
        if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < (key === 'offset' ? 0 : 1))) throw new Error('消息查询参数无效')
      }
      if (args.seq !== undefined && args.before !== undefined || args.offset !== undefined && args.seq === undefined ||
        args.days > 3650 || args.include_status !== undefined && typeof args.include_status !== 'boolean') throw new Error('消息查询参数无效')
      let target = { selfId: String(record.selfId), scope: record.scope, peerId: String(record.peerId) }
      if (args.chat !== undefined) {
        const match = /^(group|user):(\d+)$/.exec(args.chat)
        if (!match) throw new Error('chat 必须为 group:<群号> 或 user:<QQ号>')
        target = { ...target, scope: match[1] === 'group' ? 'group' : 'private', peerId: match[2] }
      }
      function assertAccess() {
        if (String(record.selfId) !== String(manager.selfId) || !canAccessChat(config, record)) {
          throw new Error('消息回查只对当前获准的 QQ 聊天开放')
        }
        if ((target.scope !== record.scope || target.peerId !== String(record.peerId)) &&
          !(record.scope === 'private' && listOf(config.ownerIds).includes(String(record.peerId)))) {
          throw new Error('跨聊天查询仅限授权账号私聊使用')
        }
        if (!canAccessChat(config, target)) throw new Error('目标聊天未获准，不能查询')
      }
      assertAccess()
      const store = manager.messageStore
      store.assertReadable(target)
      await importChatHistory(store, config, target)
      assertAccess()
      const rows = store.query(target, { ...args, since: args.days ? Date.now() - args.days * 86400000 : 0,
        limit: Math.min(args.limit ?? 10, 20) })
      let remaining = 12000
      const messages = []
      for (const row of rows) {
        if (!remaining) break
        const body = row.body ?? (row.source?.message !== undefined
          ? readMessage(row.source.message, { selfId: target.selfId }).text || '[非文字消息]'
          : row.legacy ? '[旧版本仅保留消息 ID，原文不可恢复]' : '[消息尚未准备完成]')
        const offset = args.seq ? args.offset ?? 0 : 0
        const text = body.slice(offset, offset + remaining)
        remaining -= text.length
        messages.push({ seq: row.seq, id: row.direction === 'outgoing' ? row.messageId ?? null : row.id, direction: row.direction ?? 'incoming',
          senderId: row.message?.senderId ?? row.source?.user_id,
          senderName: row.message?.senderName ?? row.source?.sender?.card ?? row.source?.sender?.nickname,
          ...(args.include_status ? { status: row.status === 'sending' ? 'uncertain' : row.status } : {}),
          ...(row.direction === 'outgoing' ? { confirmed: row.status === 'sent' || row.status === 'archived' } : {}), text, offset,
          nextOffset: offset + text.length < body.length ? offset + text.length : null,
          receivedAt: row.receivedAt })
      }
      return { ok: true, chat: `${target.scope === 'group' ? 'group' : 'user'}:${target.peerId}`, messages,
        before: messages.at(-1)?.seq ?? null,
        ...(args.include_status ? { blocked: store.blocked(target)?.reason ?? null } : {}) }
    },
  })
}
