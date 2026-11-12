/** 记录压力与压缩；窗口管理交给宿主，不主动 reset 或生成原文副本。 */
export function createContextGuard({ manager, config, logger }) {
  return {
    onSessionEvent(session, raw) {
      if (config.contextGuard === false) return
      const record = manager.find(String(session?.id ?? session?.header?.id ?? raw?.sessionId ?? ''))
      if (!record) return
      if (raw?.type === 'request/context') record.contextWindow = raw.data?.contextWindow
      if (raw?.type === 'assistant/message' && raw.data?.usage) {
        record.promptTokens = Number(raw.data.usage.inputTokens ?? 0) + Number(raw.data.usage.cacheReadTokens ?? 0)
      }
      if (raw?.type === 'compaction/end' && !Object.hasOwn(raw.data ?? {}, 'error')) {
        record.compactedCount = (record.compactedCount ?? 0) + 1
        logger.info?.('[dsh-qq] 上下文已压缩', record.label)
      }
    },
  }
}
