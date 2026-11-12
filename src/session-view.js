import { z } from 'zod'
import { assertHostAccepted } from './host-compatibility.js'

export const runtimeContextName = 'dsh-qq:current-state'
const prepared = new WeakMap()

/** 只保存组装所需的当前位置；历史回放由宿主投影注册表负责。 */
export const chatSessionView = {
  key: 'dsh-qq:session-context',
  stateVersion: 1,
  stateSchema: z.object({
    compactSeq: z.number().int(),
    lastHeaderSeq: z.number().int(),
    position: z.object({ turn: z.number().int(), step: z.number().int() }),
    systems: z.array(z.object({ seq: z.number().int(), text: z.string() })),
    runtime: z.array(z.number().int()),
  }),
  init: () => ({ compactSeq: -1, lastHeaderSeq: -1, position: { turn: 0, step: 0 }, systems: [], runtime: [] }),
  apply(state, event) {
    if (event.type === 'step/start') return { ...state, position: { turn: event.data.turn, step: event.data.step } }
    if (event.type === 'request/header') return { ...state, lastHeaderSeq: event.seq }
    if (event.type === 'compaction/end' && !Object.hasOwn(event.data, 'error')) return { ...state, compactSeq: event.seq }
    const replacement = event.surfaceOp?.op === 'replace'
    if (!replacement && event.type !== 'system/message' && event.type !== 'user/message') return state
    const sources = replacement ? new Set(event.sourceEventSeqs) : new Set()
    const oldSystemIndex = state.systems.findIndex(node => sources.has(node.seq))
    let systems = state.systems.filter(node => !sources.has(node.seq))
    let runtime = state.runtime.filter(seq => !sources.has(seq))
    if (event.type === 'system/message') {
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      systems.splice(oldSystemIndex < 0 ? systems.length : oldSystemIndex, 0, { seq: event.seq, text })
    }
    if (event.type === 'user/message' && event.data.source?.kind === 'runtime-context' &&
      event.data.source.sections?.some(section => section.name === runtimeContextName)) runtime = [...runtime, event.seq]
    if (event.type !== 'system/message' && systems.length === state.systems.length) systems = state.systems
    if (runtime.length === state.runtime.length && runtime.every((seq, i) => seq === state.runtime[i])) runtime = state.runtime
    return systems === state.systems && runtime === state.runtime ? state : { ...state, systems, runtime }
  },
}

export async function prepareSessionView(agentCtx, agent, config) {
  if (!agent?.session) throw new Error('QQ 会话需要 setup 提供完整 Agent')
  if (!prepared.has(agent)) {
    const ready = (async () => {
      assertHostAccepted(config)
      const registry = agentCtx.get('sessionProjections')
      if (!registry?.register) throw new Error('QQ 会话需要宿主 sessionProjections 服务')
      const handle = await registry.register(chatSessionView)
      return handle.readerFor(agent.session)
    })()
    prepared.set(agent, ready)
    ready.catch(() => prepared.delete(agent))
  }
  return prepared.get(agent)
}
