import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listOf } from './config.js'
import { cleanOutboundText } from './shared/outbound-text.js'
import { synthesizeVoice } from './voice.js'
import { readPrivateHistory } from './private-history.js'
import { createQzonePublisher } from './qzone.js'

/** 新工具只负责参数与会话适配，读记录、合成和发布各有独立边界。 */
export function registerExtraTools(tools, { client, manager, config, home, needRecord, assertQuiet, assertText, noteToolSent }) {
  const publisher = createQzonePublisher({ client, home })
  tools.register({
    name: 'qq_send_voice',
    description: '用 Windows SAPI 合成并发送一条语音。text 最多 500 字；to 可选 user:<QQ号> 或 group:<群号>，留空发到当前会话。',
    parameters: {
      type: 'object', properties: { text: { type: 'string' }, to: { type: 'string' } },
      required: ['text'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, messageId: { type: 'integer' } }, required: ['ok'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.ok ? '语音已发送' : '语音未发送' }],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      assertQuiet(record)
      const text = cleanOutboundText(args.text)
      await assertText(text, record, 'qq_send_voice')
      let scope = record.scope
      let peerId = record.peerId
      if (args.to) {
        const match = /^(user|group):(\d+)$/.exec(String(args.to).trim())
        if (!match) throw new Error('to 格式应为 user:<QQ号> 或 group:<群号>')
        scope = match[1] === 'group' ? 'group' : 'private'
        peerId = match[2]
      }
      const audio = await synthesizeVoice(text, { voiceName: config.voiceName })
      const result = await client.call(scope === 'group' ? 'send_group_msg' : 'send_private_msg', {
        ...(scope === 'group' ? { group_id: Number(peerId) } : { user_id: Number(peerId) }),
        message: [{ type: 'record', data: { file: `base64://${audio.toString('base64')}` } }],
      })
      const messageId = Number(result?.message_id ?? 0)
      if (scope === record.scope && String(peerId) === String(record.peerId)) {
        if (messageId) record.lastSentMessageId = messageId
        noteToolSent(record, text)
      }
      return { ok: true, messageId }
    },
  })

  tools.register({
    name: 'qq_private_history',
    description: '查询落盘的私聊流水，默认最近一天，最多七天。仅私聊可用：主人可读正文，其他人好感度到 100 仅可查时间线。user_id 留空查整体活动，指定他人仅限主人。无记录就说不知道。',
    parameters: {
      type: 'object', properties: {
        user_id: { type: 'string' }, days: { type: 'integer', minimum: 1, maximum: 7 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      }, additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, required: ['ok', 'text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const text = await readPrivateHistory({ config, home, record, userId: args.user_id, days: args.days, limit: args.limit })
      return { ok: true, text }
    },
  })

  tools.register({
    name: 'qq_qzone_send',
    description: '发布 QQ 空间说说，仅主人私聊可用。先展示完整文案、图片和可见范围，得到主人确认后再调用。默认 public，每天最多两次尝试；失败或超时不自动重发。',
    parameters: {
      type: 'object', properties: {
        text: { type: 'string' }, images: { type: 'array', items: { type: 'string' }, maxItems: 9 },
        privacy: { type: 'string', enum: ['public', 'friends', 'private'] },
      }, additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object', properties: {
          ok: { type: 'boolean' }, tid: { type: 'string' }, privacy: { type: 'string' }, images: { type: 'integer' },
        }, required: ['ok'], additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `空间已发布（${value.privacy}，${value.images} 张图）` }],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      if (record.scope !== 'private' || !listOf(config.ownerIds).includes(String(record.peerId))) {
        throw new Error('只有主人私聊可以发布空间说说')
      }
      assertQuiet(record)
      const text = cleanOutboundText(args.text)
      if (text) await assertText(text, record, 'qq_qzone_send')
      if (args.images && !Array.isArray(args.images)) throw new Error('images 必须为数组')
      if ((args.images?.length ?? 0) > 9) throw new Error('最多九张图片')
      const images = []
      for (const item of args.images ?? []) {
        const src = String(item).trim()
        if (/^(https?:\/\/|base64:\/\/)/i.test(src)) images.push(src)
        else {
          const path = src.startsWith('file:') ? fileURLToPath(src) : resolve(record.dir || config.cwd || process.cwd(), src)
          images.push(`base64://${(await readFile(path)).toString('base64')}`)
        }
      }
      return publisher({ text, images, privacy: args.privacy })
    },
  })
}
