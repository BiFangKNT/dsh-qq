import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createSystemPromptStore, pendingSystemPrompts } from './system-prompt.js'
import { applyOverrides, loadOverrides, resolvePersonaFile } from './settings.js'
import { clearRuntimeContext } from './runtime-context.js'

/** 设置进程只投递操作；会话的拥有者执行。两种部署共用这条路径。 */
export function createPromptSync({ ctx, home, config, manager, logger }) {
  const store = manager?.systemPrompts ?? createSystemPromptStore(home)
  const dir = join(home, 'prompt-sync')
  const fileOf = id => join(dir, `${id}.json`)
  const write = operation => {
    mkdirSync(dir, { recursive: true })
    const file = fileOf(operation.id)
    writeFileSync(`${file}.tmp`, JSON.stringify(operation), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  const operations = () => !existsSync(dir) ? [] : readdirSync(dir)
    .filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
    .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')))
    .sort((a, b) => a.at.localeCompare(b.at))
  const selfId = () => String(manager?.selfId || config.selfId || '')
  const pending = () => pendingSystemPrompts(store, config, selfId())
  let timer = null, stopped = false, working = false, recoveredIdentity = null
  const controller = new AbortController()

  async function execute(operation, item) {
    const snapshot = store.get(item.sessionId)
    if (!snapshot || snapshot.retired) throw new Error('会话已切换，请刷新后重试')
    const record = await manager.obtain(snapshot.meta)
    if (record.sessionId !== item.sessionId) throw new Error('会话已切换，请刷新后重试')
    await manager.enqueue(record, async () => {
      await record.agent.whenIdle()
      if (stopped) throw new Error('插件已停止')
      if (record.sessionId !== item.sessionId) throw new Error('会话已切换，请刷新后重试')
      // 等待回复期间设置也可能变化，执行时读取最新文件。
      applyOverrides(config, loadOverrides(ctx, logger, { strict: true }), logger)
      resolvePersonaFile(config, logger, { home })
      if (operation.action === 'new') await manager.replaceSession(record)
      else if (operation.action === 'force') {
        await record.agent.ctx.get('systemPrompt').assemble({ ...assembleContextFor(record.agent), qqForceSystemSync: true })
      }
      else {
        const compaction = ctx.get('compaction')
        if (!compaction?.compactNow) throw new Error('宿主未启用手动压缩服务')
        clearRuntimeContext(record.agent)
        const result = await compaction.compactNow(record.agent, controller.signal)
        if (!result) throw new Error('没有可压缩的历史，system 尚未同步；可选择创建新会话')
        await record.agent.ctx.get('systemPrompt').assemble(assembleContextFor(record.agent))
      }
    })
  }

  async function tick() {
    if (stopped || working) return
    working = true
    try {
      const identity = selfId()
      if (!identity) return
      if (recoveredIdentity !== identity) {
        // selfId 可能直到 NapCat 登录完成才知道，恢复检查放在身份就绪后。
        for (const operation of operations()) {
          if (operation.selfId !== identity || operation.status !== 'running') continue
          for (const item of operation.sessions.filter(item => item.status !== 'done')) {
            item.status = 'failed'; item.error = '服务在操作期间重启，请检查会话后重新操作'
          }
          operation.status = operation.sessions.every(item => item.status === 'done') ? 'done' : 'failed'
          write(operation)
        }
        recoveredIdentity = identity
      }
      for (const operation of operations()) {
        if (stopped) break
        if (operation.selfId !== selfId() || operation.status !== 'queued') continue
        operation.status = 'running'
        write(operation)
        for (const item of operation.sessions) {
          try { await execute(operation, item); item.status = 'done' }
          catch (err) { item.status = 'failed'; item.error = err?.message ?? String(err) }
          write(operation)
        }
        operation.status = operation.sessions.some(item => item.status === 'failed') ? 'failed' : 'done'
        write(operation)
      }
    } catch (err) { logger.warn?.('提示词同步操作失败:', err?.message ?? err) }
    finally { working = false }
  }

  return {
    status() {
      return { pending: pending(), operations: operations().filter(item => !selfId() || item.selfId === selfId()).slice(-10) }
    },
    request(action, sessionIds) {
      if (!['new', 'compact', 'force'].includes(action) || !Array.isArray(sessionIds) || !sessionIds.length ||
        sessionIds.some(id => typeof id !== 'string')) throw new Error('请选择会话和同步方式')
      const available = new Map(pending().map(item => [item.sessionId, item]))
      const sessions = [...new Set(sessionIds)].map(id => {
        const item = available.get(id)
        if (!item) throw new Error('所选会话不在待同步列表，请刷新')
        return { ...item, status: 'queued' }
      })
      const owners = new Set(sessions.map(item => item.selfId))
      if (owners.size !== 1) throw new Error('一次只能操作同一个机器人所属的会话')
      const operation = { id: randomUUID(), selfId: sessions[0].selfId, action, sessions,
        status: 'queued', at: new Date().toISOString() }
      write(operation)
      return operation
    },
    start() {
      if (!manager) return
      timer = setInterval(tick, 800)
      timer.unref?.()
    },
    stop() { stopped = true; controller.abort(new Error('插件停止')); clearInterval(timer) },
  }
}
