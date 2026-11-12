import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { hostVersions, assertHostAccepted, createHostCompatibility } from '../src/host-compatibility.js'
import { installSettingsApi, loadOverrides } from '../src/settings.js'
import { createMockDsh } from './mock-dsh.mjs'
import { installChatSystem, createSystemPromptStore } from '../src/system-prompt.js'

const unverified = { ...hostVersions, '@deepseek-ai/dsh-agent-loop': '0.2.3-rc.1' }
const logger = { warn() {}, info() {}, debug() {} }
async function directory(t) {
  const home = await mkdtemp(join(tmpdir(), 'qq-compatibility-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('未经验证默认暂停，确认精确版本后只启用一次；重启保留，版本变化重新确认', async t => {
  const home = await directory(t), config = {}, starts = []
  const gate = createHostCompatibility({ home, config, logger, versions: unverified, start: () => starts.push('start') })
  gate.sync(); gate.sync()
  assert.equal(starts.length, 0)
  assert.equal(gate.status().pending, true)
  assert.throws(() => assertHostAccepted(config, unverified), /未经验证/)
  assert.throws(() => gate.validate({ ...unverified, '@deepseek-ai/dsh-agent-loop': 'stale' }), /已变化/)
  config.acceptedDshVersions = { ...unverified }
  gate.sync(); gate.sync()
  assert.equal(starts.length, 1)
  assert.equal(gate.status().accepted, true)
  assert.doesNotThrow(() => assertHostAccepted(config, unverified))
  const resumed = createHostCompatibility({ home, config, logger, versions: unverified, start: () => starts.push('resume') })
  resumed.sync()
  assert.equal(starts.length, 2)
  const upgraded = createHostCompatibility({ home, config, logger,
    versions: { ...unverified, '@deepseek-ai/dsh-session': '0.2.3-rc.1' }, start: () => starts.push('wrong') })
  upgraded.sync()
  assert.equal(upgraded.status().pending, true)
  assert.equal(starts.length, 2)
  gate.stop(); gate.sync()
  assert.equal(starts.length, 2)
})

test('设置端只显示 QQ 运行端版本；无记录时等待，不误报设置端版本', async t => {
  const home = await directory(t), config = { uiOnly: true }
  const ui = createHostCompatibility({ home, config, logger, start: () => assert.fail('设置端不应启动 QQ') })
  ui.sync()
  assert.equal(ui.status().waiting, true)
  const worker = createHostCompatibility({ home, config: {}, logger, versions: unverified, start() {} })
  worker.sync()
  assert.deepEqual(ui.status().versions, unverified)
  assert.equal(ui.status().pending, true)
  config.acceptedDshVersions = unverified
  ui.sync()
  assert.equal(ui.status().accepted, true)
  assert.deepEqual(JSON.parse(await readFile(join(home, 'host-compatibility.json'))).versions, unverified)
})

test('已验证版本直接运行；启动失败保留设置与错误，不重复启动部分初始化的运行端', async t => {
  const home = await directory(t)
  let calls = 0
  const gate = createHostCompatibility({ home, config: {}, logger, start() { calls++; throw new Error('缺少服务') } })
  gate.sync(); gate.sync()
  assert.equal(calls, 1)
  assert.equal(gate.status().verified, true)
  assert.equal(gate.status().error, '缺少服务')
})

test('真实设置 API 拒绝过期确认，保存精确许可并启动；分进程确认由运行端读取', async t => {
  const home = await directory(t), routes = []
  const host = createMockDsh({ home, webServer: { register: route => { routes.push(route); return () => {} } } })
  let starts = 0
  const config = { uiOnly: true, localApiPort: 0 }
  const workerConfig = {}
  const worker = createHostCompatibility({ home: join(home, 'dsh-qq'), config: workerConfig, logger,
    versions: unverified, start: () => starts++ })
  // installSettingsApi 创建插件家目录，随后运行端可发布记录。
  const ui = createHostCompatibility({ home: join(home, 'dsh-qq'), config, logger, start() { assert.fail() } })
  installSettingsApi({ ctx: host.ctx, webServer: host.ctx.webServer, config, logger, compatibility: ui, overridesRef: { current: {} } })
  worker.sync()
  const server = createServer((req, res) => routes[0].handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await host.dispose() })
  const url = `http://127.0.0.1:${server.address().port}/api/dsh-qq`
  const post = versions => fetch(`${url}/compatibility`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versions }) })
  assert.equal((await post({ ...unverified, '@deepseek-ai/dsh-session': 'wrong' })).status, 409)
  assert.equal(starts, 0)
  assert.equal((await post(unverified)).status, 200)
  Object.assign(workerConfig, loadOverrides(host.ctx, logger))
  worker.sync(); worker.sync()
  assert.equal(starts, 1)
  assert.deepEqual(loadOverrides(host.ctx, logger).acceptedDshVersions, unverified)
  const status = await (await fetch(`${url}/status`)).json()
  assert.equal(status.compatibility.accepted, true)
})

test('同意风险不绕过必要接口检查', async t => {
  const home = await directory(t), host = createMockDsh({ home })
  t.after(() => host.dispose())
  const handle = await host.ctx.agents.create({ sessionId: 'missing-interface' })
  handle.agent.session.append = undefined
  await assert.rejects(installChatSystem({ agentCtx: handle.agent.ctx, agent: handle.agent,
    config: { acceptedDshVersions: hostVersions }, meta: { scope: 'private', peerId: '11001' },
    store: createSystemPromptStore(''), runtimeContext: () => 'state' }), /session.append/)
})
