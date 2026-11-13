import { createDeveloperMessage } from '@deepseek-ai/dsh-llm'
import { runtimeContextName } from './session-view.js'
import { facesForPrompt } from './faces.js'
import { faceStrategyRule, SILENT_HINT } from './prompts.js'
import { loadGroupDigest } from './settings.js'
import { listOf } from './config.js'
import { identityContext } from './identity.js'

export function buildRuntimeContext({ memory, config, record }) {
  const parts = [identityContext(config, record), memory.render(record), faceStrategyRule(config, facesForPrompt(config, 12))]
  // 跨聊天资料只向明确配置的 owner 提供，并限制到明确允许的群。
  if (record.scope === 'private' && config.groupMode !== 'disabled' && listOf(config.ownerIds).includes(String(record.peerId)) && listOf(config.groupAllow).length) {
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const digest = loadGroupDigest({ workspaceRoot: config.workspaceRoot, today: day, selfId: record.selfId,
      allowedGroups: listOf(config.groupAllow) })
    if (digest) parts.push('【授权群近况】', digest)
  }
  return parts.filter(Boolean).join('\n\n')
}

const installed = new WeakMap()

/** 先使用官方快照，响应提交后通过已记录的替换移出后续模型输入。 */
export function installRuntimeContext(agentCtx, agent, render, view) {
  if (installed.has(agent)) return installed.get(agent).dispose
  if (typeof agent.session.append !== 'function') throw new Error('QQ 状态区需要宿主 session.append 接口')
  let captured = '', failure = null, disposed = false
  let maySilent = false
  const disposers = []
  const clear = () => {
    try {
      for (const seq of view().runtime) {
        agent.session.append('developer/message', {
          ...view().position,
          message: createDeveloperMessage({ content: [], source: { kind: 'dsh-qq:state-cleared' } }),
        }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
      }
      failure = null
    } catch (error) { failure = error; throw error }
  }
  const guardedClear = () => {
    try { clear() }
    catch (error) { agentCtx.logger?.warn?.(`QQ 状态区清理失败，后续请求将停止：${error.message}`) }
  }
  const dispose = () => {
    if (disposed) return
    // 清理失败时保留保护监听器，不能卸掉保护后继续使用会话。
    clear()
    disposed = true
    for (const off of disposers.reverse()) off()
    installed.delete(agent)
  }
  try {
    clear()
    disposers.push(agentCtx.get('systemPrompt').context({ name: runtimeContextName, order: 1000,
      required: true, interpolate: false, text: () => captured }))
    disposers.push(agentCtx.on('agent/pre-step', async ({ messages }, next) => {
      clear()
      // 在宿主实际取出消息时更新，排队中的下一轮不能提前影响当前轮。
      // 工具续调没有新消息，继续沿用本轮要求；主动机会等其他入口不继承它。
      if (messages.length) maySilent = messages.every(message => message.source?.qqMaySilent === true)
      captured = [render(), maySilent ? SILENT_HINT : ''].filter(Boolean).join('\n\n')
      return next()
    }, { prepend: true }))
    disposers.push(agentCtx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type === 'end' && frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/message') guardedClear()
    }))
    disposers.push(agentCtx.on('agent/status', ({ status }) => { if (status === 'idle') guardedClear() }))
    disposers.push(agentCtx.on('agent/request-error', async ({ failure: requestFailure }, next) => {
      if (requestFailure.code === 'CONTEXT_WINDOW_EXCEEDED') clear()
      if (failure) throw failure
      return next()
    }, { prepend: true }))
    // 不改写请求。即使回调清理失败，也不允许把污染的 compact 输入发给模型。
    disposers.push(agentCtx.on('llm/stream', (request, next) => {
      if (request.sessionId !== agent.session.id) return next()
      if (failure) throw failure
      if (request.purpose === 'compaction' && request.messages.some(message =>
        message.source?.kind === 'runtime-context' && message.source.sections?.some(section => section.name === runtimeContextName))) {
        throw new Error('QQ 状态区尚未清理，拒绝将状态快照发送给压缩模型')
      }
      return next()
    }, { prepend: true }))
  } catch (error) {
    for (const off of disposers.reverse()) off()
    throw error
  }
  installed.set(agent, { dispose, clear })
  return dispose
}

export function clearRuntimeContext(agent) { installed.get(agent)?.clear() }
