import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import agent from '@deepseek-ai/dsh-agent/package.json' with { type: 'json' }
import loop from '@deepseek-ai/dsh-agent-loop/package.json' with { type: 'json' }
import llm from '@deepseek-ai/dsh-llm/package.json' with { type: 'json' }
import session from '@deepseek-ai/dsh-session/package.json' with { type: 'json' }
import projection from '@deepseek-ai/dsh-session-projection/package.json' with { type: 'json' }
import prompt from '@deepseek-ai/dsh-system-prompt/package.json' with { type: 'json' }

export const supportedDshVersion = '0.2.2-rc.2'
export const hostVersions = Object.freeze(Object.fromEntries([agent, loop, llm, session, projection, prompt]
  .map(pkg => [pkg.name, pkg.version])))

export function sameHostVersions(a, b) {
  return a && b && Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([key, value]) => typeof value === 'string' && b[key] === value)
}

export function assertHostAccepted(config, versions = hostVersions) {
  if (Object.values(versions).every(version => version === supportedDshVersion) || sameHostVersions(versions, config.acceptedDshVersions)) return
  throw new Error(`当前 DSH 核心包版本未经验证，请在 QQ 设置中确认风险后启用；已验证版本为 ${supportedDshVersion}`)
}

/** 设置进程读取运行端版本；确认内容与版本逐项绑定，不使用永久放行开关。 */
export function createHostCompatibility({ config, home, logger, start, versions = hostVersions }) {
  const file = join(home, 'host-compatibility.json')
  let started = false, stopped = false, error = ''
  const publish = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify({ versions, error }), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  const observed = () => {
    if (!config.uiOnly) return { versions, error }
    if (!existsSync(file)) return null
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!value.versions || !Object.keys(value.versions).length ||
      Object.entries(value.versions).some(([key, version]) => !Object.hasOwn(hostVersions, key) || typeof version !== 'string') ||
      Object.keys(value.versions).length !== Object.keys(hostVersions).length) throw new Error('QQ 运行端版本记录格式错误')
    return value
  }
  const status = () => {
    const current = observed()
    if (!current) return { waiting: true, verifiedVersion: supportedDshVersion, versions: null }
    const verified = Object.values(current.versions).every(version => version === supportedDshVersion)
    const accepted = !verified && sameHostVersions(current.versions, config.acceptedDshVersions)
    return { verifiedVersion: supportedDshVersion, versions: current.versions, verified, accepted,
      pending: !verified && !accepted, error: current.error || '' }
  }
  return {
    status,
    validate(accepted) {
      if (!sameHostVersions(status().versions, accepted)) throw new Error('QQ 运行端版本已变化，请刷新后重新确认')
    },
    sync() {
      if (config.uiOnly || stopped) return
      const current = status()
      if (!current.pending && !started && !error) {
        started = true
        try { start() }
        catch (err) { error = err.message; logger.warn?.('QQ 启用失败:', error) }
      }
      publish()
    },
    stop() { stopped = true },
  }
}
