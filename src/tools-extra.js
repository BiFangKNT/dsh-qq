import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listOf } from './config.js'
import { cleanOutboundText } from './shared/outbound-text.js'
import { synthesizeVoice } from './voice.js'
import { createQzonePublisher } from './qzone.js'
import { resolveSendTarget, assertSendAccess, parseMessageId } from './tool-send.js'

/** 新工具只负责参数与会话适配，读记录、合成和发布各有独立边界。 */
export function registerExtraTools(tools, { client, manager, config, home, needRecord, assertText, noteToolSent, synthesize = synthesizeVoice }) {
  const publisher = createQzonePublisher({ client, home })
  tools.register({
    name: 'qq_send_voice',
    description: '仅 Windows 可用：用本机 SAPI 合成并发送语音，其他平台无法使用当前实现。text 最多 500 字；to 可选 user:<QQ号> 或 group:<群号>，留空发到当前聊天。跨聊天发送仅授权账号私聊可用，当前聊天和目标均须获准。发送结果不确定时先检查目标聊天，不自动重发。',
    parameters: {
      type: 'object', properties: { text: { type: 'string' }, to: { type: 'string' } },
      required: ['text'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, messageId: { type: 'integer' }, reason: { type: 'string' } }, required: ['ok'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.ok ? '语音已发送' : value.reason }],
    },
    async execute(args, exec) {
      const record = needRecord(manager, exec)
      const target = resolveSendTarget(record, args?.to)
      assertSendAccess(manager, config, record, target)
      const text = cleanOutboundText(args.text)
      await assertText(text, record, 'qq_send_voice')
      assertSendAccess(manager, config, record, target)
      const audio = await synthesize(text, { voiceName: config.voiceName })
      assertSendAccess(manager, config, record, target)
      const result = await client.call(target.scope === 'group' ? 'send_group_msg' : 'send_private_msg', {
        ...(target.scope === 'group' ? { group_id: Number(target.peerId) } : { user_id: Number(target.peerId) }),
        message: [{ type: 'record', data: { file: `base64://${audio.toString('base64')}` } }],
      })
      const messageId = parseMessageId(result?.message_id ?? result?.data?.message_id)
      if (messageId === null) return { ok: false, messageId: 0, reason: '回执缺少有效消息 ID，发送未确认。请先检查目标聊天，不自动重发。' }
      noteToolSent(record, text, target, messageId)
      return { ok: true, messageId }
    },
  })

  tools.register({
    name: 'qq_qzone_send',
    description: '发布 QQ 空间说说，仅授权账号私聊可用。先展示完整文案、图片和可见范围，得到该账号确认后再调用。默认 public，每天最多两次尝试；失败或超时不自动重发。',
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
        throw new Error('只有授权账号私聊可以发布空间说说')
      }
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
