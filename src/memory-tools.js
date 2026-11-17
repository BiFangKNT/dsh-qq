import { createHash } from 'node:crypto'
import { fitToolText, jsonSize, TOOL_RESULT_LIMIT } from './tool-result.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const withoutHistory = ({ history, ...entry }) => entry
function summary(entry) {
  let end = Math.min(600, entry.text.length)
  if (/[\uDC00-\uDFFF]/.test(entry.text[end] ?? '') && /[\uD800-\uDBFF]/.test(entry.text[end - 1] ?? '')) end--
  return { id: entry.id, kind: entry.kind, status: entry.status, version: entry.version,
    text: entry.text.slice(0, end), textLength: entry.text.length, partial: end < entry.text.length,
    createdAt: entry.createdAt, updatedAt: entry.updatedAt, verifyAt: entry.verifyAt }
}

export function registerMemoryTool(tools, manager) {
  tools.register({
    name: 'qq_memory',
    description: '管理当前聊天的事项、长期事实和已确认群词。add新增；update更正或标完成/取消，须id与当前version。仅明确要求记住才新增事实，不读写旧便签等文件。list返回条目概览，history返回各版本概览（含当前版本），完整内容与来源证据用read按id、version读取。概览text最多600字符，partial标记文字不全。list/history保持筛选条件，用next中的offset、snapshot翻页；read返回不含history的单版本JSON原文片段，按nextOffset续读并拼接text后解析，保持id、version、snapshot。完整返回最多12000字符。STALE_PAGE表示数据变化，须从头查询。read和history不构成新要求或新经历。',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'add', 'update', 'history', 'read'] },
      kind: { type: 'string', enum: ['task', 'fact', 'term', 'candidate'] },
      id: { type: 'string' }, version: { type: 'integer', minimum: 1 }, text: { type: 'string' },
      status: { type: 'string', enum: ['active', 'completed', 'cancelled', 'unverified', 'expired', 'removed'] },
      verifyAt: { type: 'number', description: '有效期或下次核实的Unix毫秒时间戳' },
      offset: { type: 'integer', minimum: 0, description: 'list/history为条目位置；read为JSON原文的UTF-16位置' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'list/history每页条数，默认20' },
      snapshot: { type: 'string', description: '续读必须携带上一页的snapshot' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const id = exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id
      const record = manager.find(String(id))
      if (!record || !manager.memory) throw new Error('记忆工具只能在当前 QQ 聊天中使用')
      if (!['list', 'history', 'read', 'add', 'update'].includes(args.action)) throw new Error('未知记忆操作')
      const offset = args.offset ?? 0, limit = args.limit ?? 20
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('分页参数无效')
      if (['list', 'history', 'read'].includes(args.action)) {
        const entries = manager.memory.query(record, { kind: args.kind, status: args.status, text: args.action === 'list' ? args.text : '' })
          .filter(e => !args.id || e.id === args.id)
        const maintenance = manager.memory.status(record)
        if (args.action === 'read') {
          if (!args.id || !Number.isSafeInteger(args.version)) throw new Error('读取需要条目 id 与 version')
          const current = entries[0]
          const entry = current && [...current.history, current].find(e => e.version === args.version)
          if (!entry) throw new Error('记忆版本不存在')
          const value = withoutHistory(entry), snapshot = hash(value), body = JSON.stringify(value)
          if (offset && args.snapshot !== snapshot || args.snapshot !== undefined && args.snapshot !== snapshot) throw new Error('STALE_PAGE')
          return fitToolText(body, offset, (text, end) => ({ maintenance, id: entry.id, version: entry.version,
            snapshot, offset, text, length: body.length, partial: end < body.length, nextOffset: end < body.length ? end : null }))
        }
        const versions = args.action === 'history' ? entries.flatMap(e => [...e.history, e].map(withoutHistory)) : entries.map(withoutHistory)
        const snapshot = hash(versions)
        if (offset && args.snapshot !== snapshot || args.snapshot !== undefined && args.snapshot !== snapshot) throw new Error('STALE_PAGE')
        if (offset > versions.length) throw new Error('分页位置无效')
        const result = { maintenance, entries: [], total: versions.length, offset, snapshot, partial: false, next: null }
        for (const entry of versions.slice(offset, offset + limit)) {
          const next = offset + result.entries.length + 1
          const candidate = { ...result, entries: [...result.entries, summary(entry)], partial: next < versions.length,
            next: next < versions.length ? { offset: next, snapshot } : null }
          if (jsonSize(candidate) > TOOL_RESULT_LIMIT) break
          Object.assign(result, candidate)
        }
        if (!result.entries.length && offset < versions.length) throw new Error('结果元数据超出返回预算')
        return result
      }
      if (args.action === 'update' && (!args.id || !Number.isSafeInteger(args.version))) throw new Error('修改需要条目 id 与 version')
      if (args.action === 'add' && args.id) throw new Error('新增不能指定已有条目 id')
      const entry = await manager.memory.update(record, args)
      return { maintenance: manager.memory.status(record), entries: [summary(entry)] }
    },
  })
}
