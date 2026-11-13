import { listOf } from './config.js'
import { readPlainText } from './onebot/segment.js'

export const retiredGroupSettings = ['groupWakeMs', 'groupWakeIdleMs', 'groupRepliesPerWindow',
  'groupReplyGapMs', 'groupWakeNameMention', 'groupWakeQuestion', 'groupWakeKeywords',
  'groupWakeProbability', 'groupWakeNames', 'historyLimit']

/** 旧免 @ 名单只迁移一次；明确配置的逐群值优先。 */
export function migrateGroupSettings(input) {
  const next = { ...input }
  if (Object.hasOwn(next, 'groupFree')) {
    next.groupMentionOverrides = { ...Object.fromEntries(listOf(next.groupFree).map(id => [id, false])),
      ...next.groupMentionOverrides }
    delete next.groupFree
  }
  for (const key of retiredGroupSettings) delete next[key]
  return next
}

export function requiresGroupMention(config, peerId) {
  const override = config.groupMentionOverrides?.[String(peerId)]
  return typeof override === 'boolean' ? override : config.requireMention !== false
}

export function groupMessageInterval(config) {
  const value = Number(config.groupMessageIntervalMs ?? 30000)
  if (!Number.isFinite(value) || value < 1) throw new Error('普通群聊处理间隔必须为正数')
  return value
}

export function matchesGroupTrigger(config, message) {
  const words = listOf(config.groupTriggerWords)
  if (!words.length) return false
  const text = readPlainText(message)
  return words.some(word => text.includes(word))
}
