// 本地敏感内容检查，不调用模型；路径和通用的 password/key 示例不作为默认拦截依据。
const SECRET_PATTERNS = [
  ['api-key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['github-fine-grained-token', /\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
]

export const sensitiveContentNotice = '这条回复包含疑似敏感信息，未发送。'

export class SensitiveContentError extends Error {
  constructor(rule) {
    super(`${sensitiveContentNotice}（${rule}）`)
    this.code = 'QQ_SENSITIVE_CONTENT'
  }
}

/** 仅返回规则标识，不返回命中内容或正则原文。 */
export function auditOutbound(text, { knownSecrets = [], extraPatterns = [] } = {}) {
  const value = String(text ?? '')
  if (!value) return { ok: true }
  if (knownSecrets.some(secret => typeof secret === 'string' && secret.length > 0 && value.includes(secret))) {
    return { ok: false, kind: 'credential', rule: 'configured-credential' }
  }
  for (const [rule, pattern] of SECRET_PATTERNS) {
    if (pattern.test(value)) return { ok: false, kind: 'credential', rule }
  }
  for (const [index, source] of extraPatterns.entries()) {
    try {
      if (new RegExp(source, 'i').test(value)) return { ok: false, kind: 'custom', rule: `custom-${index + 1}` }
    } catch {
      // 保持现有配置兼容：无效正则不影响其他检查。
    }
  }

  return { ok: true }
}

/** 正文和工具共用同一检查边界；只记录定位信息及规则，不记录原文。 */
export function checkOutboundText(text, { config, logger, record, source, knownSecrets = [] }) {
  if (config?.auditOutbound === false) return { ok: true }
  const verdict = auditOutbound(text, {
    knownSecrets: [config?.accessToken, ...knownSecrets],
    extraPatterns: config?.auditExtraPatterns ?? [],
  })
  if (!verdict.ok) logger?.warn?.('[dsh-qq] 外发敏感内容已阻止', JSON.stringify({
    scope: record?.scope, peerId: record?.peerId, sessionId: record?.sessionId,
    messageId: record?.lastMessageId, source, rule: verdict.rule,
  }))
  return verdict
}
