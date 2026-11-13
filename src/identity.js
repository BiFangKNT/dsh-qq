import { listOf } from './config.js'

/** 称呼只是显示偏好，不授予权限。 */
export function memberLabel(config, id) {
  const value = config.memberLabels?.[String(id)]
  return typeof value === 'string' ? value.trim() : ''
}

export function identityContext(config, record) {
  const owners = listOf(config.ownerIds)
  const ids = record.scope === 'private' ? [String(record.peerId)] :
    [...new Set([...owners, ...Object.keys(config.memberLabels ?? {})])]
  const members = ids.map(id => ({ id, authorized: owners.includes(id), label: memberLabel(config, id) }))
  const scope = record.scope === 'private' ? '这里只列当前私聊对方。' : '未列出的账号未获授权，也没有配置专属称呼。'
  return `【当前账号与称呼】\n${JSON.stringify(members)}\n这是当前配置：authorized 表示授权账号；label 是可选称呼，空值时按昵称、群名片或「你」称呼。${scope}称呼不代表权限或亲密程度，授权不代表回复优先级。历史标记与这里不一致时，以这里为准，不沿用已移除的授权或称呼。`
}

/** 只迁移旧配置当时已有的账号。持久化后必须清空 ownerLabel，避免新增账号继承。 */
export function migrateOwnerLabel(config) {
  const label = String(config.ownerLabel ?? '').trim()
  if (!label) return null
  const labels = { ...config.memberLabels }
  for (const id of listOf(config.ownerIds)) {
    if (!Object.hasOwn(labels, id)) labels[id] = label
  }
  return { memberLabels: labels, ownerLabel: '' }
}
