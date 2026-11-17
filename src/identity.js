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
  return `【当前账号与称呼】\n${JSON.stringify(members)}`
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
