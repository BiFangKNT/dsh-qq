// 仅本地计量，不访问模型或 QQ。首次加载、缓存复用、大积压和系列切换分别计时。
import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContextBudget } from '../src/context-budget.js'
import { createMessageStore } from '../src/message-store.js'
import { createMockPromptScope } from './mock-dsh.mjs'

const home = mkdtempSync(join(tmpdir(), 'qq-budget-bench-'))
const store = createMessageStore(home), config = { contextTokenizerFamily: 'v41' }
const results = {}
async function measure(name, run) {
  const start = performance.now(), value = await run()
  results[name] = { ms: Math.round((performance.now() - start) * 100) / 100, value }
}
try {
  const llm = { prepareCall: async config => ({ config: { maxTokens: 8192, ...config }, context: { contextWindow: 1000000 } }) }
  const ctx = { get: key => key === 'llm' ? llm : undefined }
  const capacity = createContextBudget({ ctx, config, store })
  const body = '群里讨论事情的进展，引用之前的消息，随后说明任务已经完成。'.repeat(5000)
  await measure('firstTokenizerLoadAnd150kChars', () => capacity.textCount(body))
  await measure('cachedSameText', () => capacity.textCount(body))
  await measure('newShortMessage', () => capacity.textCount('新增消息：这件事处理完了，不需要继续提醒。'))
  const record = { selfId: '90001', scope: 'group', peerId: '70001', sessionId: 'bench' }
  const scope = createMockPromptScope(ctx)
  record.agent = { ctx: scope, model: { current: () => ({ provider: 'mock', model: 'mock' }) },
    session: { id: 'bench', deriveMessages: () => [] } }
  await measure('persist1000LongMessages', async () => {
    for (let n = 0; n < 1000; n++) store.put(record, { id: String(n), body: `${n}：${body.slice(0, 3000)}`,
      message: { text: '消息' }, source: {}, receivedAt: n })
    return 1000
  })
  await measure('selectFrom3mCharsBacklog', async () => {
    const plan = await capacity.select(record, {}, store, store.summary(record).end,
      (selected, omitted) => `未提供 ${omitted.length} 条\n${selected.map(row => row.body).join('\n')}`)
    return { selected: plan.selected.length, omitted: plan.omitted.length, tokens: plan.tokens, limit: plan.limit }
  })
  await measure('repeatSameBacklog', async () => {
    const plan = await capacity.select(record, {}, store, store.summary(record).end,
      (selected, omitted) => `未提供 ${omitted.length} 条\n${selected.map(row => row.body).join('\n')}`)
    return plan.tokens
  })
  config.contextTokenizerFamily = 'v4'
  await measure('switchTokenizerFamily', () => capacity.textCount(body))
  console.log(JSON.stringify({ node: process.version, ...results }, null, 2))
} finally { store.close(); rmSync(home, { recursive: true, force: true }) }
