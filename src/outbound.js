/**
 * 将宿主 text 正文发送到 QQ，reasoning 和工具调用消息不外发。
 * 流式按原始字符位置补齐落定消息，不按语言或措辞删改正文。
 */
import { SILENT_MARKER } from './prompts.js'
import { cleanOutboundText } from './shared/outbound-text.js'
import { clearToolSends, toolSendTexts } from './tool-result.js'

function sessionIdOf(session, raw) {
  const id = session?.header?.id ?? session?.id ?? raw?.sessionId ?? raw?.session?.header?.id ?? raw?.session?.id
  return id == null ? '' : String(id)
}

export function extractText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('')
}

export function hasToolUse(message) {
  return Array.isArray(message?.content) &&
    message.content.some(part => /tool|function/i.test(String(part?.type ?? '')))
}

const SENTENCE_END = /^([\s\S]*?[。！？!?…\n])/
const MIN_SENTENCE = 6

// 只对真实发送工具的相同内容去重，保留发送结果说明和后续不同正文。
function withoutToolEcho(record, value) {
  let text = value
  const sent = toolSendTexts(record)
  const candidates = [...sent, sent.join('\n')].filter(Boolean).sort((a, b) => b.length - a.length)
  while (text) {
    const previous = candidates.find(candidate => text === candidate ||
      text.startsWith(candidate) && /^\s/.test(text.slice(candidate.length)))
    if (!previous) break
    text = text.slice(previous.length).trim()
  }
  return text
}

export function createOutbound({ manager, config, logger, send, wake }) {
  const lastSent = new Map()
  const streams = new Map()
  const sensitiveBlocked = new Set()
  const streamMax = Number(config.streamMaxChunks ?? 3)

  async function emit(record, text) {
    if (sensitiveBlocked.has(record.sessionId)) return { ok: false }
    const result = await send(record, text)
    if (result?.reason === 'sensitive-content') sensitiveBlocked.add(record.sessionId)
    if (result?.ok !== false || result?.sent || result?.noticeSent) wake?.noteOutbound?.(record)
    return result
  }

  function reset(record, sessionId) {
    lastSent.delete(sessionId)
    streams.delete(sessionId)
    clearToolSends(record)
  }

  return async function onSessionEvent(...args) {
    const raw = args.length >= 2 ? args[1] : args[0]
    const session = args.length >= 2 ? args[0] : raw?.session
    const sessionId = sessionIdOf(session, raw)
    if (!sessionId) return
    const record = manager.find(sessionId)
    if (!record) return
    const type = raw?.type ?? '', data = raw?.data ?? {}

    if (type === 'turn/start') {
      reset(record, sessionId)
      sensitiveBlocked.delete(sessionId)
      return
    }
    if (type === 'assistant/chunk') {
      if (config.streamReply === false || record.scope === 'group') return
      const chunk = data.chunk
      if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return
      const state = streams.get(sessionId) ?? { buffer: '', consumed: 0, count: 0, halted: false }
      state.buffer += chunk.text
      streams.set(sessionId, state)
      // 发送工具之后等待完整正文，才能按实际内容去重。
      if (toolSendTexts(record).length || state.halted || state.buffer.includes(SILENT_MARKER)) return
      while (state.buffer.length >= MIN_SENTENCE && state.count < streamMax) {
        const match = SENTENCE_END.exec(state.buffer)
        if (!match) break
        if (!match[1].trim()) {
          state.buffer = state.buffer.slice(match[0].length)
          state.consumed += match[0].length
          continue
        }
        if (match[1].trim().length < MIN_SENTENCE) break
        const text = cleanOutboundText(match[1])
        const result = text ? await emit(record, text) : null
        state.buffer = state.buffer.slice(match[0].length)
        state.consumed += match[0].length
        state.count++
        if (result?.ok === false) { state.halted = true; break }
      }
      return
    }
    if (type === 'assistant/message') {
      const state = streams.get(sessionId)
      streams.delete(sessionId)
      if (hasToolUse(data.message)) return
      const rawText = extractText(data.message)
      if (rawText.includes(SILENT_MARKER)) {
        wake?.noteProactiveSilent?.(record)
        return
      }
      const text = cleanOutboundText(rawText)
      if (!text) {
        wake?.noteProactiveSilent?.(record)
        return
      }
      const previous = lastSent.get(sessionId) ?? ''
      if (text === previous || previous.startsWith(text) && text.length < previous.length) return
      // 重复事件不自动重发，结果未知或被拒绝也算已经尝试过。
      lastSent.set(sessionId, text)
      if (state?.halted) return
      let rest = state?.consumed ? cleanOutboundText(rawText.slice(state.consumed)) : text
      if (!state?.consumed && previous && rest.startsWith(previous)) rest = rest.slice(previous.length).trim()
      rest = withoutToolEcho(record, rest)
      if (rest) await emit(record, rest)
      return
    }
    if (type === 'turn/end') {
      const blocked = sensitiveBlocked.delete(sessionId)
      reset(record, sessionId)
      if (record._proactiveAt) record._proactiveAt = 0
      const reason = data.reason
      if (reason?.kind === 'error') {
        wake?.noteProactiveFailed?.(record)
        if (blocked || reason.error?.code === 'QQ_SENSITIVE_CONTENT' || reason.failure?.code === 'QQ_SENSITIVE_CONTENT') return
        const message = reason.error?.message || reason.failure?.message || reason.failure?.code || '处理时出错了'
        logger.warn?.(`[dsh-qq] ${record.label} 本轮出错: ${message}`)
        await emit(record, /CONTEXT_WINDOW_EXCEEDED|maximum context length/i.test(String(message))
          ? '这轮上下文处理失败，当前会话和原消息已保留。请尝试压缩会话，或明确选择 /new 新建会话。'
          : `⚠️ ${message}`)
      }
      return
    }
    if (type === 'tool/call' && config.showToolResults) {
      await emit(record, `🔧 调用 ${data.name || 'tool'}`)
    }
    if (type === 'tool/result' && config.showToolResults) {
      const error = data.error
      if (error?.code === 'QQ_SENSITIVE_CONTENT') return
      if (error) await emit(record, `⚠️ 工具失败: ${error.message ?? error.code ?? error}`)
    }
  }
}
