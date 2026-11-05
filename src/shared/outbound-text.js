/** 模型偶尔泄漏的正文包装标签；所有文字发送入口共用。 */
export function cleanOutboundText(value) {
  return String(value ?? '').replace(/<\/?text>/gi, '').trim()
}
