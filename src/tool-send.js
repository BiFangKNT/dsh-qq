import { canAccessChat } from './access.js'
import { listOf } from './config.js'

/** OneBot 消息 ID 是有符号整数；缺失或无效值用 null 区分，零值也有效。 */
export function parseMessageId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

/** 解析工具发送目标；显式填写当前聊天不算跨聊天发送。 */
export function resolveSendTarget(record, to) {
  if (to === undefined || to === '') return { selfId: record.selfId, scope: record.scope, peerId: String(record.peerId) }
  if (typeof to !== 'string') throw new Error('to 格式应为 user:<QQ号> 或 group:<群号>')
  const value = to.trim()
  if (!value) return { selfId: record.selfId, scope: record.scope, peerId: String(record.peerId) }
  const match = /^(user|group):(\d+)$/i.exec(value)
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) {
    throw new Error('to 格式应为 user:<QQ号> 或 group:<群号>，号码须为有效正整数')
  }
  return { selfId: record.selfId, scope: match[1].toLowerCase() === 'group' ? 'group' : 'private', peerId: String(Number(match[2])) }
}

/** 在合成或外发前调用；异步准备结束后再次检查当前权限。 */
export function assertSendAccess(manager, config, record, target) {
  if (String(record.selfId) !== String(manager.selfId) || String(target.selfId) !== String(manager.selfId) ||
    !canAccessChat(config, record)) throw new Error('当前聊天未获准发送消息')
  const crossChat = target.scope !== record.scope || target.peerId !== String(record.peerId)
  if (crossChat && (record.scope !== 'private' || !listOf(config.ownerIds).includes(String(record.peerId)))) {
    throw new Error('跨聊天发送仅限授权账号私聊使用')
  }
  if (!canAccessChat(config, target)) throw new Error('目标聊天未获准，不能发送')
}
