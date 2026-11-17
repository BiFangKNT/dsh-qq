import { parseMessageId } from './tool-send.js'

export const TOOL_RESULT_LIMIT = 12000
export const jsonSize = value => JSON.stringify(value).length

// 在完整返回预算内截取连续文字；不拆开 UTF-16 代理对，不修改原文。
export function fitToolText(text, offset, build, limit = TOOL_RESULT_LIMIT) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length ||
    offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? '') && /[\uD800-\uDBFF]/.test(text[offset - 1])) {
    throw new Error('续读位置无效')
  }
  const at = length => {
    let end = offset + length
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]) && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--
    return end
  }
  let low = 0, high = text.length - offset
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const end = at(mid)
    if (jsonSize(build(text.slice(offset, end), end)) <= limit) low = mid
    else high = mid - 1
  }
  const end = at(low), value = build(text.slice(offset, end), end)
  if (jsonSize(value) > limit || end === offset && offset < text.length) throw new Error('结果元数据超出返回预算')
  return value
}

/** 仅把协议明确拒绝或调用前未连接归为失败，其余异常保留结果未确认。 */
export async function callToolAction(client, action, params, logger) {
  try {
    return await client.call(action, params)
  } catch (err) {
    logger?.warn?.(`${action} 工具调用失败：${err?.message ?? err}`)
    const state = err?.onebotDelivery === 'rejected'
      ? `协议拒绝${Number.isSafeInteger(err.retcode) ? `（retcode=${err.retcode}）` : ''}`
      : err?.onebotDelivery === 'not-sent' ? '未发送：连接不可用' : '结果未确认'
    throw new Error(state)
  }
}

export async function sendToolMessage(client, action, params, logger) {
  const result = await callToolAction(client, action, params, logger)
  const messageId = parseMessageId(result?.message_id ?? result?.data?.message_id)
  if (messageId === null) throw new Error('发送未确认：回执缺少消息 ID')
  return messageId
}

export const EXTERNAL_ACTION_RULE = '异常分为未发送、协议拒绝和结果未确认；未确认可能已执行，先核对，不自动重试。'
