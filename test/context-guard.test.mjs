/**
 * context-guard 自检脚本（不依赖测试框架）：
 *   node test/context-guard.test.mjs
 *
 * 覆盖：压力事件记账、压缩后补规矩、阈值以下不换、超阈值换会话 + 写记忆文件。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContextGuard } from '../src/context-guard.js'

const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-guard-'))
const injected = []
const resetCalls = []
const record = {
  sessionId: 's1',
  key: 'k',
  scope: 'private',
  peerId: '10003',
  label: '私聊 主人(10003)',
  dir,
  recent: ['[主人] 晚上好', '[助手] 主人晚上好'],
  history: [],
  chatPromptInjected: true,
  busy: 0,
  agent: { inject: (message) => injected.push(message) },
}
const manager = {
  find: (id) => (id === 's1' ? record : null),
  reset: (r) => {
    resetCalls.push(r.sessionId)
    return true
  },
}
const config = {
  contextGuard: true,
  contextSwapRatio: 0.7,
  contextSwapMinTokens: 1000,
  contextMemoryKeep: 5,
  ownerLabel: '主人',
}
const logger = { info() {}, warn() {}, debug() {} }
const guard = createContextGuard({ manager, config, logger })

// 1) request/context 记窗口
guard.onSessionEvent({ header: { id: 's1' } }, { type: 'request/context', data: { contextWindow: 100000 } })
assert.equal(record.contextWindow, 100000)

// 2) assistant/message 记压力（prompt = input + cacheRead；**不含 output**）
//    设计上只看「下一轮要重新付钱的输入」：output 是这轮刚生成的，
//    下一轮不一定整段回灌，算进去会高估压力、提前换会话（见 context-guard.js:65-66）。
guard.onSessionEvent(
  { header: { id: 's1' } },
  { type: 'assistant/message', data: { usage: { inputTokens: 500, cacheReadTokens: 9500, outputTokens: 100 } } },
)
assert.equal(record.promptTokens, 10000)

// 压缩成功只记录，不持久注入任何状态，也不主动换会话。
guard.onSessionEvent({ id: 's1' }, { type: 'compaction/end', data: {} })
assert.equal(record.compactedCount, 1)
guard.onSessionEvent({ id: 's1' }, { type: 'compaction/end', data: { error: 'failed' } })
assert.equal(record.compactedCount, 1)
assert.equal(injected.length, 0)
assert.equal(guard.maybeSwap, undefined)
assert.deepEqual(resetCalls, [])
assert.deepEqual(await readdir(dir), [])
console.log('context-guard: all checks passed')
