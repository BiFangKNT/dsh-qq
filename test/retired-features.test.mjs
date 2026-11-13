import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Config } from '../src/index.js'
import { createMockEnvironment } from './mock-environment.mjs'
import { waitFor } from './mock-dsh.mjs'

test('旧阅读与信箱配置不再注入提醒或登记已读，旧用户文件保留', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-qq-retired-'))
  let env
  t.after(async () => { await env?.close(); await rm(root, { recursive: true, force: true }) })
  const inbox = join(root, 'inbox')
  await mkdir(inbox)
  const letter = join(inbox, 'message.md'), bookmark = join(root, 'bookmark.md')
  await writeFile(letter, '旧信件正文')
  await writeFile(bookmark, '旧阅读书签')
  env = await createMockEnvironment({ root, config: {
    doorDir: inbox, doorReplyPrefix: 'reply-', doorSenderLabel: '旧信箱',
    readingEnabled: true, readingBook: '旧书', readingBookmark: bookmark,
    readingChapterDir: root, readingAskGapMs: 1, readingPeer: '11001',
  } })
  const settings = await (await fetch(`${env.url}/api/dsh-qq/settings`)).json()
  assert.equal(Object.keys(settings.values).some(key => key.startsWith('door') || key.startsWith('reading')), false)
  env.emitMessage({ text: '普通消息', steps: [{ type: 'tool', name: 'read', args: { path: 'message.md' } }] })
  await waitFor(() => [...env.host.agents.values()].some(agent => agent.session.events.some(event => event.type === 'turn/end')))
  const agent = [...env.host.agents.values()][0]
  assert.ok(agent.session.events.some(event => event.type === 'tool/result' && event.data.name === 'read'))
  assert.doesNotMatch(JSON.stringify(agent.received), /门口|旧信箱|阅读机会/)
  await assert.rejects(readFile(join(inbox, '.已读.json')), { code: 'ENOENT' })
  assert.equal(await readFile(letter, 'utf8'), '旧信件正文')
  assert.equal(await readFile(bookmark, 'utf8'), '旧阅读书签')
})

test('默认关闭主动发言，显式启用的现有配置保留', () => {
  assert.equal(Config({}).proactiveEnabled, false)
  assert.equal(Config({ proactiveEnabled: true }).proactiveEnabled, true)
})
