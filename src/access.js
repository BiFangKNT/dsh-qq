import { listOf } from './config.js'

export function allowPrivate(config, userId) {
  if (!config.replyToPrivate || config.privateMode === 'disabled') return false
  return config.privateMode !== 'allowlist' || listOf(config.privateAllow).includes(String(userId))
}

export function allowGroup(config, groupId) {
  if (config.groupMode === 'disabled') return false
  return config.groupMode !== 'allowlist' || listOf(config.groupAllow).includes(String(groupId))
}

export function canAccessChat(config, record) {
  if (record.scope === 'group') return allowGroup(config, record.peerId)
  return record.scope === 'private' && allowPrivate(config, record.peerId) &&
    (config.botChatEnabled || !listOf(config.peerBots).includes(String(record.peerId)))
}
