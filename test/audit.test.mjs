import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditOutbound, checkOutboundText } from '../src/audit.js'

test('普通聊天、路径及通用凭据示例默认放行', () => {
  for (const text of ['', null, '今晚月色真好', 'C:\\Users\\example\\config.json', '/home/example/.config',
    'file:///C:/tmp/a.png', 'password: hunter2hunter2', 'api_key = abcd1234efgh5678',
    'Authorization: Bearer example-documentation-token']) {
    assert.deepEqual(auditOutbound(text), { ok: true }, text)
  }
})

test('匹配已知凭据原值，不限制长度，不匹配空配置', () => {
  assert.deepEqual(auditOutbound('包含 actual-token-value', { knownSecrets: ['', 'actual-token-value'] }),
    { ok: false, kind: 'credential', rule: 'configured-credential' })
  assert.equal(auditOutbound('令牌是 abc', { knownSecrets: ['abc'] }).ok, false)
  assert.equal(auditOutbound('大小写不同 ABC', { knownSecrets: ['abc'] }).ok, true)
  assert.equal(auditOutbound('普通正文', { knownSecrets: ['', undefined] }).ok, true)
})

test('少量明确的密钥格式仍阻止，结果不包含命中原文', () => {
  for (const [secret, rule] of [
    ['sk-abcdefghijklmnopqrstuvwx', 'api-key'],
    [`ghp_${'a'.repeat(36)}`, 'github-token'],
    [`github_pat_${'a'.repeat(70)}`, 'github-fine-grained-token'],
  ]) {
    const result = auditOutbound(`不要发送 ${secret}`)
    assert.deepEqual(result, { ok: false, kind: 'credential', rule })
    assert.ok(!JSON.stringify(result).includes(secret))
  }
  assert.equal(auditOutbound('ghp_example sk-placeholder').ok, true)
})

test('自定义正则可拦路径，无效规则不妨碍后续规则，返回序号而非规则原文', () => {
  const result = auditOutbound('位置 /home/example/config', { extraPatterns: ['([invalid', '/home/'] })
  assert.deepEqual(result, { ok: false, kind: 'custom', rule: 'custom-2' })
  assert.deepEqual(auditOutbound('普通正文', { extraPatterns: ['([invalid'] }), { ok: true })
})

test('正文和工具检查配置一致；日志只有定位信息和规则，不包含凭据及正文', () => {
  const logs = [], record = { scope: 'private', peerId: '11001', sessionId: 'test-session', lastMessageId: 42 }
  const config = { accessToken: 'configured-token' }
  const logger = { warn: (...args) => logs.push(args) }
  for (const source of ['reply', 'qq_send', 'qq_reply', 'qq_send_voice', 'qq_qzone_send']) {
    assert.equal(checkOutboundText('机密原文 configured-token', { config, logger, record, source }).ok, false)
    assert.equal(checkOutboundText('连接仍用 old-token', { config, logger, record, source, knownSecrets: ['old-token'] }).ok, false)
  }
  const serialized = JSON.stringify(logs)
  assert.doesNotMatch(serialized, /configured-token|old-token|机密原文|连接仍用/)
  assert.match(serialized, /42/)
  assert.match(serialized, /configured-credential/)
  config.auditOutbound = false
  const before = logs.length
  assert.equal(checkOutboundText(config.accessToken, { config, logger, record }).ok, true)
  assert.equal(logs.length, before)
})
