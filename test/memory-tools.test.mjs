import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemory } from '../src/memory.js'
import { createMemoryStore } from '../src/memory-store.js'
import { registerMemoryTool } from '../src/memory-tools.js'

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'qq-memory-tools-'))
  const record = { selfId: '90001', scope: 'private', peerId: '10001', sessionId: 'main' }
  const memory = createMemory({ home, config: {} }), store = createMemoryStore(home)
  let tool
  registerMemoryTool({ register: value => { tool = value } }, { find: id => id === 'main' ? record : null, memory })
  t.after(() => { memory.stop(); rmSync(home, { recursive: true, force: true }) })
  return { memory, record, store, call: args => tool.execute(args, { agent: { session: { id: 'main' } } }) }
}
const bounded = value => assert.ok(JSON.stringify(value).length <= 12000)

test('记忆列表及版本历史按总JSON分页，不重复遗漏，数据变更拒绝旧页', async t => {
  const h = fixture(t), ids = []
  for (let n = 0; n < 33; n++) {
    const result = await h.call({ action: 'add', kind: 'fact', text: String(n) + '"\\\n'.repeat(400) })
    bounded(result)
    ids.push(result.entries[0].id)
  }
  let args = { action: 'list' }, first, seen = []
  do {
    const page = await h.call(args)
    bounded(page)
    seen.push(...page.entries.map(e => e.id))
    first ??= page
    args = page.next ? { action: 'list', ...page.next } : null
  } while (args)
  assert.deepEqual(seen, ids)
  for (let version = 1; version <= 27; version++) await h.call({ action: 'update', id: ids[0], version, text: '版本' + version })
  await assert.rejects(h.call({ action: 'list', ...first.next }), /STALE_PAGE/)
  args = { action: 'history', id: ids[0], limit: 7 }
  const versions = []
  do {
    const page = await h.call(args)
    bounded(page)
    assert.ok(page.entries.every(e => !('history' in e)))
    versions.push(...page.entries.map(e => e.version))
    args = page.next ? { action: 'history', id: ids[0], limit: 7, ...page.next } : null
  } while (args)
  assert.deepEqual(versions, Array.from({ length: 28 }, (_, n) => n + 1))
  const empty = await h.call({ action: 'list', text: '不存在的内容' })
  assert.deepEqual(empty.entries, [])
  assert.equal(empty.partial, false)
})

test('单条记忆含超长正文和来源证据也可完整续读，写入不返回整段历史', async t => {
  const h = fixture(t)
  const text = '"\\\n😀'.repeat(8000)
  const added = await h.call({ action: 'add', kind: 'fact', text })
  bounded(added)
  assert.equal(added.entries[0].partial, true)
  const id = added.entries[0].id
  const data = h.store.read(h.record)
  data.entries[0].evidence = [{ id: 'evidence', text: text.repeat(2) }]
  h.store.write(h.record, data, data.revision)
  const original = h.memory.query(h.record)[0]
  let args = { action: 'read', id, version: 1 }, joined = '', first
  do {
    const page = await h.call(args)
    bounded(page)
    first ??= page
    joined += page.text
    args = page.nextOffset === null ? null : { action: 'read', id, version: 1, offset: page.nextOffset, snapshot: page.snapshot }
  } while (args)
  const { history, ...expected } = original
  assert.deepEqual(JSON.parse(joined), expected)
  await assert.rejects(h.call({ action: 'read', id, version: 1, offset: first.nextOffset }), /STALE_PAGE/)
  const updated = await h.call({ action: 'update', id, version: 1, text: '新内容' })
  bounded(updated)
  const old = await h.call({ action: 'read', id, version: 1 })
  assert.equal(old.snapshot, first.snapshot, '旧版本仍可稳定读取')
})
