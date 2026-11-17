import { createDeveloperMessage } from '@deepseek-ai/dsh-llm'
import { runtimeContextName } from './session-view.js'
import { facesForPrompt } from './faces.js'
import { faceStrategyRule, faceCollectRule, SILENT_HINT } from './prompts.js'
import { loadGroupDigest } from './group-digest.js'
import { listOf } from './config.js'
import { identityContext } from './identity.js'

export function buildRuntimeContext({ memory, config, record, capacity }) {
  if (capacity) return boundedContext({ memory, config, record, capacity })
  const parts = ['【当前资料】', identityContext(config, record), memory.render(record),
    faceStrategyRule(config, config.stickerEnabled === false ? null : facesForPrompt(config, 12))]
  // 跨聊天资料只向明确配置的 owner 提供，并限制到明确允许的群。
  if (record.scope === 'private' && config.groupMode !== 'disabled' && listOf(config.ownerIds).includes(String(record.peerId)) && listOf(config.groupAllow).length) {
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const digest = loadGroupDigest({ workspaceRoot: config.workspaceRoot, today: day, selfId: record.selfId,
      allowedGroups: listOf(config.groupAllow) })
    if (digest) parts.push('【授权群近况】', digest)
  }
  parts.push('【本轮条件】', faceCollectRule(config))
  return parts.filter(Boolean).join('\n\n')
}

/** 自动提供量有上限，完整记录仍由原工具按权限查询。 */
async function boundedContext({ memory, config, record, capacity }) {
  const route = record.agent ? capacity.conversationConfig(record) : { provider: config.provider, model: config.model }
  const { hard } = await capacity.route(route)
  const limit = Math.min(8192, Math.floor(hard / 8))
  let state
  try { state = memory.contextEntries(record) }
  catch { state = { failed: true, pending: true, entries: [] } }
  const tasks = state.entries.filter(entry => entry.kind === 'task')
  const facts = state.entries.filter(entry => entry.kind !== 'task')
  const identities = JSON.parse(identityContext(config, record).split('\n').slice(1).join('\n'))
  const faces = config.stickerEnabled === false ? null : facesForPrompt(config, 12)
  let digest = ''
  if (record.scope === 'private' && config.groupMode !== 'disabled' && listOf(config.ownerIds).includes(String(record.peerId)) && listOf(config.groupAllow).length) {
    const date = new Date(), day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    digest = loadGroupDigest({ workspaceRoot: config.workspaceRoot, today: day, selfId: record.selfId, allowedGroups: listOf(config.groupAllow) })
  }
  let conditions = faceCollectRule(config)
  if (await capacity.textCount(conditions) > Math.floor(limit / 8)) {
    conditions = '普通图片自动收藏规则过长未提供，不自动收藏；用户明确要求仍可处理。'
  }
  const selected = { identities: [], tasks: [], facts: [], names: [], digest: '' }
  const memoryLine = entry => `- ${entry.id} v${entry.version}：${entry.text}${entry.verifyAt ? `（核实时间 ${new Date(entry.verifyAt).toISOString()}）` : ''}`
  const list = (label, entries, lines) => `${label}：${entries.length} 条\n${lines.join('\n')}${entries.length > lines.length
    ? `\n未提供 ${entries.length - lines.length} 条，可用 qq_memory 查询；未提供不代表不存在或已完成。` : ''}`
  const render = () => ['【当前资料】', '【当前账号与称呼】', JSON.stringify(selected.identities),
    identities.length > selected.identities.length ? `未提供 ${identities.length - selected.identities.length} 条账号与称呼；未列出不代表未授权，权限仍由程序校验。` : '',
    '【当前记忆状态】', state.failed ? '记忆读取失败，当前事项与事实尚未核实。' : state.pending
      ? '当前事项尚未核实：有新消息未整理。' : tasks.length ? '' : '当前没有已记录的有效跟进事项。',
    list('有效当前事项', tasks, selected.tasks), list('当前聊天的有效记忆', facts, selected.facts),
    faceStrategyRule(config, { total: faces?.total ?? 0, names: selected.names }),
    faces?.total ? '表情名称仅为摘录，完整收藏用 qq_faces 查询。' : '',
    selected.digest ? `【授权群近况】\n${selected.digest}` : digest ? '授权群近况因预算未提供，可用 qq_history 按权限查询原文。' : '',
    '【本轮条件】', conditions,
  ].filter(Boolean).join('\n\n')
  // 预留全部缺失说明、段落分隔与本轮沉默条件，再选择完整条目。
  let used = await capacity.textCount(`${render()}\n\n${SILENT_HINT}`) + 128
  if (used > limit) throw new Error('状态区预算不足以提供必要说明，请检查模型容量')
  const add = async (items, key, format = item => item, ceiling = limit) => {
    for (const item of items) {
      const value = format(item), cost = await capacity.textCount(key === 'names' || typeof value !== 'string' ? JSON.stringify(value) : value) + 8
      if (used + cost <= ceiling) { selected[key].push(value); used += cost }
    }
  }
  await add(identities, 'identities', item => item, Math.min(limit, used + Math.floor(limit / 8)))
  await add(tasks, 'tasks', memoryLine)
  await add(facts, 'facts', memoryLine)
  await add(faces?.names ?? [], 'names')
  if (digest && used + await capacity.textCount(digest) + 16 <= limit) selected.digest = digest
  const text = render()
  if (await capacity.textCount(`${text}\n\n${SILENT_HINT}`) > limit) throw new Error('状态区实际内容超出预算，请检查模型容量')
  return text
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
      captured = [await render(), maySilent ? SILENT_HINT : ''].filter(Boolean).join('\n\n')
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
