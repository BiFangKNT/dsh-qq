import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { renderPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { clearRuntimeContext } from './runtime-context.js'
import { runtimeContextName } from './session-view.js'

const sources = JSON.parse(readFileSync(new URL('../assets/tokenizers/sources.json', import.meta.url), 'utf8'))
let worker, sequence = 0
let testVersion = 0
const jobs = new Map(), counts = new Map()
function tokenize(family, text) {
  if (!worker) {
    const active = new Worker(new URL('./token-worker.js', import.meta.url))
    worker = active
    active.on('message', result => {
      const job = jobs.get(result.id)
      jobs.delete(result.id)
      if (result.error) job?.reject(new Error(result.error))
      else job?.resolve(result.count)
      if (!jobs.size) active.unref()
    })
    const fail = error => {
      if (worker !== active) return
      for (const job of jobs.values()) job.reject(error)
      jobs.clear(); worker = null
    }
    active.on('error', fail)
    active.on('exit', code => { if (worker === active) fail(new Error(`分词线程已退出：${code}`)) })
    worker.unref()
  }
  worker.ref()
  return new Promise((resolve, reject) => { const id = ++sequence; jobs.set(id, { resolve, reject }); worker.postMessage({ id, family, text }) })
}

export function createContextBudget({ ctx, config, store, logger, encode = tokenize }) {
  const llm = ctx.get('llm')
  const localCounts = encode === tokenize ? counts : new Map()
  const encoderVersion = encode === tokenize ? '' : `:test-${++testVersion}`
  const requested = new WeakSet()
  async function textCount(text) {
    text = String(text ?? '')
    const family = config.contextTokenizerFamily ?? 'v41'
    const source = sources.find(source => source.file === `${family}.json`)
    if (!source) throw new Error('请选择受支持的 DeepSeek tokenizer 系列')
    const version = `${source.sha256}:hf-0.2.0:ordinary-text:framing-1${encoderVersion}`
    const hash = createHash('sha256').update(text).digest('hex'), key = `${version}:${hash}`
    if (localCounts.has(key)) return localCounts.get(key)
    const saved = store.tokenGet(version, hash)
    const result = saved ?? await encode(family, text)
    if (!Number.isSafeInteger(result) || result < 0) throw new Error('token 计数无效')
    if (saved === undefined) store.tokenSave(version, [[hash, result]])
    localCounts.set(key, result)
    if (localCounts.size > 4096) localCounts.delete(localCounts.keys().next().value)
    return result
  }
  async function route(options) {
    if (!options.provider || !options.model) throw new Error('无法确定本次模型路由，消息已保留')
    const prepared = await llm.prepareCall({ provider: options.provider, model: options.model,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}) }, options.signal)
    const window = prepared.context?.contextWindow, output = prepared.config.maxTokens
    if (!Number.isSafeInteger(window) || !Number.isSafeInteger(output) || output <= 0) throw new Error('模型未声明上下文窗口或输出上限，拒绝猜测容量')
    return { window, output, hard: window - output, config: prepared.config }
  }
  async function inputBudget(options) {
    const budget = await route(options)
    const base = ctx.get('compaction')?.config
    const policy = base?.modelPolicies?.find(item => item.provider === options.provider && item.model === options.model)
    const headroom = policy?.headroomTokens ?? base?.headroomTokens ?? 65536
    const ratio = policy?.thresholdRatio ?? base?.thresholdRatio ?? 0.8
    const limit = Math.floor(Math.min(budget.window * ratio, budget.hard - headroom))
    if (!(limit > 0)) throw new Error('上下文扣除输出和压缩预留后没有可用空间，请调整宿主压缩配置')
    return { ...budget, limit }
  }
  function conversationConfig(record) {
    const agent = record.agent, header = agent.session.requestHeader?.()
    const { provider, model, reasoningEffort } = agent.model?.current() ?? header?.config ??
      { provider: config.provider, model: config.model }
    // 自建或恢复的驱动首轮使用 AgentOptions；已有驱动沿用请求头中的显式控制。
    // 宿主标记为 adapterDefaults 的旧值需要重新由当前模型解析。
    const first = record.owned === true && !requested.has(agent)
    const maxTokens = first || !header ? agent.options?.maxTokens
      : header.adapterDefaults?.maxTokens === true ? undefined : header.config?.maxTokens
    return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(maxTokens === undefined ? {} : { maxTokens }) }
  }
  async function measure(options) {
    let result = 1024 + await textCount(JSON.stringify(options.tools ?? []))
    const messages = options.messages ?? []
    const hasSystem = messages.some(message => message.role === 'system')
    if (!hasSystem && options.system) result += await textCount(options.system) + 64
    const images = []
    for (const message of messages) {
      result += 64
      for (const block of message.content ?? []) {
        if (block.type === 'image') images.push(block)
        else if (block.type === 'file') {
          if (!llm.fileRequestText) throw new Error('宿主没有文件输入计量接口')
          result += await textCount(llm.fileRequestText(block.attachment)) + 16
        } else result += await textCount(block.text ?? JSON.stringify(block)) + 16
      }
    }
    if (images.length) {
      const pricing = llm.imageRequestPricing?.(options.provider, options.model)
      if (!pricing) throw new Error('模型未声明图片 token 计量，不能按图片路径长度代替')
      const prices = pricing.priceImages(images)
      if (prices.length !== images.length) throw new Error('图片计量数量不一致')
      for (const price of prices) {
        if (!Number.isSafeInteger(price.visualTokens) || price.visualTokens < 0) throw new Error('图片计量无效')
        result += price.visualTokens + await textCount(price.text)
      }
    }
    return result
  }
  async function envelope(record, manager) {
    const assembly = await record.agent.ctx.get('systemPrompt').assemble(assembleContextFor(record.agent))
    const selection = conversationConfig(record)
    const state = manager.runtimeContext?.(record) ?? ''
    const sections = renderContextSections(assembly).filter(section => section.name !== runtimeContextName)
    const tail = [...sections.map(section => section.text), state].filter(Boolean).join('\n\n')
    const history = record.agent.session.deriveMessages().filter(message => message.content?.length &&
      !(message.source?.kind === 'runtime-context' && message.source.sections?.some(section => section.name === runtimeContextName)))
    // 最新 system 已由宿主渲染；旧历史 system 属于历史，不能与其重复计数。
    const system = renderPrompt(assembly)
    const first = history.findIndex(message => message.role === 'system')
    if (first >= 0) history[first] = { role: 'system', content: [{ type: 'text', text: system }] }
    return { ...selection, system, tools: assembly.tools, messages: history,
      ...(tail ? { tail: { role: 'user', content: [{ type: 'text', text: tail }] } } : {}) }
  }
  const api = {
    textCount, measure, route, inputBudget,
    fingerprint(record) { return JSON.stringify([conversationConfig(record), ctx.get('compaction')?.config]) },
    async select(record, manager, messageStore, end, render) {
      const choose = async () => {
        const base = await envelope(record, manager), budget = await inputBudget(base)
        const selected = [], costs = []
        let before = Number.MAX_SAFE_INTEGER, stopped = false
        const fixed = await measure({ ...base, messages: [...base.messages, ...(base.tail ? [base.tail] : [])] })
        let used = fixed
        while (!stopped) {
          const page = messageStore.page(record, { end, before, limit: 64 })
          if (!page.length) break
          for (const item of page) {
            const price = await textCount(item.body) + 80
            if (used + price > budget.limit) { stopped = true; break }
            selected.push(item); costs.push(price); used += price; before = item.seq
          }
        }
        selected.reverse(); costs.reverse()
        return { base, budget, selected, costs, fixed, overflow: stopped }
      }
      let plan = await choose()
      if (plan.overflow && record.agent.session.deriveMessages().some(message => message.role !== 'system')) {
        const compaction = ctx.get('compaction')
        if (!compaction?.compactNow) throw new Error('输入超预算且宿主没有压缩服务，消息已保留')
        clearRuntimeContext(record.agent)
        await compaction.compactNow(record.agent, new AbortController().signal)
        // null 表示没有可压缩内容，也只尝试一次。
        plan = await choose()
      }
      if (!plan.selected.length || plan.selected.at(-1).seq !== messageStore.page(record, { end, limit: 1 })[0]?.seq) {
        throw new Error('本次触发消息无法完整放入上下文，原文已保留')
      }
      const all = messageStore.pendingSequences(record, end)
      let selected = plan.selected
      for (;;) {
        const ids = new Set(selected.map(item => item.seq)), omitted = all.filter(seq => !ids.has(seq))
        const body = render(selected, omitted)
        const total = await measure({ ...plan.base, messages: [...plan.base.messages,
          { role: 'user', content: [{ type: 'text', text: body }] }, ...(plan.base.tail ? [plan.base.tail] : [])] })
        if (total <= plan.budget.limit) return { selected, omitted, body, tokens: total, limit: plan.budget.limit }
        if (selected.length <= 1) throw new Error('触发消息和必要说明超出输入预算，原文已保留')
        selected = selected.slice(1)
      }
    },
    async classifierPending(messageStore, meta, input, options) {
      const budget = await inputBudget(options)
      const end = messageStore.get(meta, input.id).seq - 1
      let tokens = await textCount(JSON.stringify(input.message)) + 4096, before = Number.MAX_SAFE_INTEGER
      const selected = []
      for (;;) {
        const page = messageStore.page(meta, { end, before, limit: 64 })
        if (!page.length) break
        for (const item of page) {
          before = item.seq
          if (item.id === input.id || item.body === null) continue
          const cost = await textCount(JSON.stringify({ id: item.id, seq: item.seq, body: item.body, message: item.message, imageError: item.imageError })) + 80
          if (tokens + cost > budget.limit) return selected.reverse()
          tokens += cost; selected.push(item)
        }
      }
      return selected.reverse()
    },
    async classifierRequest(options) {
      const budget = await inputBudget(options)
      const payload = JSON.parse(options.messages[0].content[0].text)
      const noteMissing = (key, values) => {
        if (!values.length) return
        const old = (payload.missingRanges ??= {})[key]
        payload.missingRanges[key] = { count: (old?.count ?? 0) + values.length,
          firstSeq: values.reduce((lowest, value) => Math.min(lowest, value), old?.firstSeq ?? Infinity),
          lastSeq: values.reduce((highest, value) => Math.max(highest, value), old?.lastSeq ?? 0) }
      }
      // 独立输入只移除完整旧消息；不会压缩或改写主会话。
      while (await measure(options) > budget.limit) {
        if (payload.mainContext?.messages?.length) {
          const messages = payload.mainContext.messages
          let cut = 1
          // 连同所在工具轮一起移除；只在下一条完整用户消息前切开。
          while (cut < messages.length && messages[cut].role !== 'user') cut++
          for (;;) {
            const calls = new Set(messages.slice(0, cut).flatMap(message => message.content ?? [])
              .filter(block => block.type === 'tool-call').map(block => block.id))
            const result = messages.findLastIndex((message, index) => index >= cut && message.role === 'tool' && calls.has(message.toolCallId))
            if (result < cut) break
            cut = result + 1
            while (cut < messages.length && messages[cut].role !== 'user') cut++
          }
          noteMissing('mainContext', messages.splice(0, cut).map(message => message.qqContextIndex))
        } else if (payload.pendingMessages.length) noteMissing('pending', [payload.pendingMessages.shift().seq])
        else throw new Error('分类器本条消息超出输入预算，消息已保留')
        payload.missingContext = true
        // 图片按来源重建，不能删除文字后继续发送已截掉消息的图片。
        const retained = new Set(payload.pendingMessages.map(item => item.id))
        const main = new Set((payload.mainContext?.messages ?? []).map(message => message.qqContextIndex))
        const blocks = options.messages[0].content.slice(1)
        const kept = payload.imageInputs.map((source, index) => ({ source, block: blocks[index] }))
          .filter(({ source }) => source.source === 'current' ||
            (source.source === 'mainContext' ? main.has(source.contextIndex) : retained.has(source.messageId)))
        payload.imageInputs = kept.map(({ source }, imageIndex) => ({ ...source, imageIndex }))
        options = { ...options, messages: [{ ...options.messages[0], content: [
          { type: 'text', text: JSON.stringify(payload) }, ...kept.map(item => item.block),
        ] }] }
      }
      return options
    },
    async check(options) {
      try {
        const budget = await route(options), total = await measure(options)
        if (total > budget.hard) throw new Error(`最终请求含辅助输入后超出预算：${total}/${budget.hard}；停止发送，保留会话与消息`)
        return { total, ...budget }
      } catch (error) { throw new Error('输入容量检查失败：' + error.message, { cause: error }) }
    },
    install(agentCtx, agent) {
      return agentCtx.on('llm/stream', async function* (request, next) {
        if (request.sessionId === agent.session.id) {
          if (request.purpose !== 'compaction') requested.add(agent)
          await api.check(request)
        }
        yield* next()
      }, { prepend: true })
    },
  }
  return api
}
