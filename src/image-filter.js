import { imageSize } from 'image-size'
import { listOf } from './config.js'

/** 群号:QQ号[:宽x高]；不带尺寸的规则优先。缺少发送人时不能确认放行。 */
export function imagePolicy(config, groupId, userId) {
  const policy = { all: false, sizes: [] }
  if (groupId == null) return policy
  for (const rule of listOf(config?.groupImageBlock)) {
    const match = /^(\d+):(\d+)(?::([1-9]\d*)[xX×]([1-9]\d*))?$/.exec(rule)
    if (!match || match[1] !== String(groupId)) continue
    if (userId == null) { policy.all = true; continue }
    if (match[2] !== String(userId)) continue
    if (!match[3]) policy.all = true
    else policy.sizes.push({ width: Number(match[3]), height: Number(match[4]) })
  }
  return policy
}

/** 在写入可被模型读取的缓存之前检查；无法识别尺寸时抛错，由下载流程拒绝该图。 */
export function blocksImage(buffer, policy) {
  if (policy?.all) return true
  if (!policy?.sizes?.length) return false
  const { width, height } = imageSize(buffer)
  return policy.sizes.some(size => size.width === width && size.height === height)
}
