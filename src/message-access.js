import { canAccessChat } from './access.js'
import { parseMessageId } from './tool-send.js'

/** 本地接收/发送记录或协议字段必须能确认聊天归属；消息 ID 本身不授予访问权。 */
export async function readChatMessage({ client, manager, config, record, messageId, own = false, logger }) {
  const assertCurrent = () => {
    if (!canAccessChat(config, record) || String(record.selfId) !== String(manager.selfId)) {
      throw new Error('当前聊天未获准访问消息')
    }
  }
  assertCurrent()
  let response
  try { response = await client.call('get_msg', { message_id: messageId }) }
  catch (error) {
    logger?.warn?.(`get_msg 工具查询失败：${error?.message ?? error}`)
    throw new Error('取消息失败')
  }
  const message = response?.data ?? response
  assertCurrent()
  if (!message || typeof message !== 'object' ||
    message.message_id !== undefined && parseMessageId(message.message_id) !== messageId) {
    throw new Error('消息回执无效')
  }
  const known = manager.messageStore?.hasMessage(record, messageId) === true
  const groupId = message.group_id
  const privatePeer = String(message.sender?.user_id) === String(record.selfId)
    ? message.target_id : message.sender?.user_id ?? message.user_id
  const confirmed = record.scope === 'group'
    ? groupId != null && String(groupId) === String(record.peerId)
    : groupId == null && message.message_type === 'private' && String(privatePeer) === String(record.peerId)
  const contradicted = record.scope === 'group'
    ? groupId != null && String(groupId) !== String(record.peerId) || message.message_type === 'private'
    : groupId != null || message.message_type === 'group' || privatePeer != null && String(privatePeer) !== String(record.peerId)
  if (contradicted || !known && !confirmed) throw new Error('消息不属于当前聊天，或无法确认聊天归属')
  if (own && String(message.sender?.user_id) !== String(record.selfId)) throw new Error('只能撤回机器人自己发送的消息')
  return message
}
