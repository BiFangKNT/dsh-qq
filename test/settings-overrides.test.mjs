import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { applyOverrides, installSettingsApi, loadOverrides, resolvePersonaFile } from '../src/settings.js'

test('清除覆盖恢复基础值，数组和对象不污染基础快照，原本不存在的项被删除', () => {
  const config = { debug: false, groupAllow: ['11001'], groupMentionOverrides: { '22001': false } }
  const identity = config
  applyOverrides(config, { debug: true, groupAllow: ['11002'], groupMentionOverrides: {}, memoryModel: 'override' })
  config.groupAllow.push('11003')
  applyOverrides(config, {})
  assert.equal(config, identity)
  assert.deepEqual(config, { debug: false, groupAllow: ['11001'], groupMentionOverrides: { '22001': false } })
  config.groupMentionOverrides['22001'] = true
  config.groupAllow.push('11004')
  applyOverrides(config, {})
  assert.deepEqual(config.groupAllow, ['11001'])
  assert.deepEqual(config.groupMentionOverrides, { '22001': false })
})

test('基础旧群配置先迁移，清除文件覆盖不丢失 profile 中的逐群条件', () => {
  const config = { groupFree: ['22001'], groupMentionOverrides: { '22002': true } }
  applyOverrides(config, { groupFree: ['22003'] })
  assert.deepEqual(config.groupMentionOverrides, { '22003': false })
  applyOverrides(config, {})
  assert.equal(Object.hasOwn(config, 'groupFree'), false)
  assert.deepEqual(config.groupMentionOverrides, { '22001': false, '22002': true })
})

test('移除人设文件覆盖恢复文本人设，不残留上次读出的文件内容', t => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-qq-persona-reset-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const personaFile = join(home, 'persona.md')
  writeFileSync(personaFile, '文件人设')
  const config = { persona: '基础人设', personaFile: '' }
  applyOverrides(config, { personaFile })
  resolvePersonaFile(config)
  assert.equal(config.persona, '文件人设')
  applyOverrides(config, {})
  resolvePersonaFile(config)
  assert.equal(config.persona, '基础人设')
})

test('页面 null 清除与文件空覆盖一致；同时返回重连、重启和新会话提示', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-qq-settings-reset-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const cleanups = []
  t.after(() => cleanups.reverse().forEach(cleanup => cleanup()))
  let handler
  const ctx = { get: () => () => home, effect: setup => { const cleanup = setup(); if (cleanup) cleanups.push(cleanup) } }
  const config = { localApiPort: 0, debug: false, accessToken: 'initial', workspaceRoot: '', preset: '', asrPython: '' }
  const overridesRef = { current: {} }
  installSettingsApi({ ctx, config, overridesRef, logger: {},
    webServer: { register: route => { handler = route.handler; return () => {} } } })
  async function post(patch) {
    const req = Readable.from([Buffer.from(JSON.stringify({ patch }))])
    Object.assign(req, { method: 'POST', url: '/api/dsh-qq/settings' })
    let status, body
    await handler(req, { writeHead: value => { status = value }, end: value => { body = JSON.parse(value) } })
    return { status, ...body }
  }
  let result = await post({ debug: true, accessToken: 'changed', workspaceRoot: home, preset: 'chat', asrPython: 'custom' })
  assert.equal(result.status, 200)
  assert.equal(result.needReconnect, true)
  assert.equal(result.needRestart, true)
  assert.deepEqual(result.effects, { reconnect: ['accessToken'], restart: ['workspaceRoot'], newSession: ['preset'] })
  result = await post({ debug: null, accessToken: null, workspaceRoot: null, preset: null, asrPython: null })
  assert.equal(result.status, 200)
  assert.equal(result.values.debug, false)
  assert.equal(result.values.accessToken, 'initial')
  assert.deepEqual(overridesRef.current, {})
  assert.deepEqual(loadOverrides(ctx, {}, { strict: true }), {})
  assert.equal(result.needReconnect, true)
  assert.equal(result.needRestart, true)
  result = await post({ asrPython: 'custom', splitDelayMeanMs: 0 })
  assert.equal(result.needRestart, false)
  assert.equal(result.values.splitDelayMeanMs, 0)
  result = await post({ memoryRoot: 'D:/shared-files' })
  assert.equal(result.values.memoryRoot, 'D:/shared-files')
  assert.equal(result.needRestart, true)
  result = await post({ memoryRoot: 123 })
  assert.equal(result.status, 400)
  assert.equal(config.memoryRoot, 'D:/shared-files')
  result = await post({ memoryRoot: null })
  assert.equal(result.needRestart, true)
  assert.equal(config.memoryRoot, undefined)
  result = await post({ splitDelayMeanMs: -1 })
  assert.equal(result.status, 400)
  assert.equal(config.splitDelayMeanMs, 0)
  writeFileSync(join(home, 'settings.json'), '{')
  assert.throws(() => loadOverrides(ctx, {}, { strict: true }))
})
