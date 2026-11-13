import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockEnvironment } from './mock-environment.mjs'
import { waitFor, textOf } from './mock-dsh.mjs'

test('关闭分类器的夜间私聊保留完整原文和图片；重启、换会话后关闭作息只交付一次', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qq-sleep-delivery-'))
  const minutes = new Date().getHours() * 60 + new Date().getMinutes()
  const hm = minute => `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`
  const env = await createMockEnvironment({ root, autoReply: false, config: {
    addressClassifierEnabled: false, sleepMode: true, holdNightMessages: true, bedtimeAt: '',
    sleepFrom: hm((minutes + 1439) % 1440), sleepTo: hm((minutes + 10) % 1440),
  } })
  t.after(async () => { await env.close(); rmSync(root, { recursive: true, force: true }) })
  const pendingDir = join(root, 'dsh-qq', 'address-classifier')
  const pending = () => existsSync(pendingDir) ? readdirSync(pendingDir).filter(f => f.endsWith('.json'))
    .flatMap(f => JSON.parse(readFileSync(join(pendingDir, f), 'utf8')).pending ?? []) : []
  const long = '完整正文'.repeat(300) + '末尾不可丢失'
  env.emitMessage({ text: long, image: true, messageId: 90001 })
  await waitFor(() => pending().some(item => item.body?.includes('末尾不可丢失')), { what: '休息消息完整落盘' })
  assert.equal(env.snapshot().sessions[0].received.length, 0)
  const oldId = env.snapshot().sessions[0].id
  await env.reload()
  assert.equal(env.snapshot().sessions.reduce((n, s) => n + s.received.length, 0), 0)
  env.emitMessage({ text: '/new', messageId: 90002 })
  await waitFor(() => env.napcat.calls.some(call => call.action === 'send_private_msg'), { what: '休息时仍可新建会话' })
  const saved = await fetch(`${env.url}/api/dsh-qq/settings`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { sleepMode: false } }) })
  assert.equal(saved.status, 200)
  await waitFor(() => env.snapshot().sessions.some(s => s.received.length === 1), { what: '关闭作息后自动交付' })
  const session = env.snapshot().sessions.find(s => s.received.length === 1)
  assert.notEqual(session.id, oldId)
  assert.ok(textOf(session.received[0]).includes(long))
  assert.match(textOf(session.received[0]), /\.png/)
  await waitFor(() => pending().length === 0, { what: '交付进度落盘' })
  await env.reload()
  env.emitMessage({ text: '之后的普通私聊', messageId: 90003 })
  await waitFor(() => env.snapshot().sessions.some(s => s.received.length === 2))
  const messages = env.snapshot().sessions.find(s => s.received.length === 2).received
  assert.equal(messages.filter(m => textOf(m).includes('末尾不可丢失')).length, 1)
  assert.match(textOf(messages[1]), /之后的普通私聊/)
})
