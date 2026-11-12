import { join } from 'node:path'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { deriveSessionId, sessionKey } from './shared/session-id.js'
import { ensurePeerWorkspace, resolvePeerWorkspace } from './workspace.js'
import { createSessionState } from './session-state.js'
import { createSystemPromptStore, installChatSystem, pendingSystemPrompts } from './system-prompt.js'

/**
 * 一个 QQ 会话（私聊 or 群）对应一个 DSH Agent。
 *
 * 生命周期：
 *   obtain()  → 内存命中 → 宿主里活着的 → resume 历史 → create 新建
 *   闲置超过 sessionIdleTimeout 且没有在跑的 turn → dispose + 清表
 *
 * 注意：`ctx.agents.create({ meta })` 的 meta 是**会持久化并被校验**的字段，
 * 只认 cwd / parentSession / seedLength / origin / delegationDepth / agentPreset，
 * 塞自定义键会被 session 边界拒绝，所以这里不往里放业务字段。
 */
export class SessionManager {
  #records = new Map() // sessionId -> record
  #byPeer = new Map() // peerKey -> sessionId
  #gens = new Map() // basePeerKey -> 代数（/reset 一次 +1，换一个全新 sessionId）
  #ready = new Map() // 已铺好的会话目录（避免每次 attach 都 mkdir）
  #sweeper = null
  #obtaining = new Map()

  constructor({ ctx, agents, selfId, config, logger, home = '' }) {
    this.ctx = ctx
    this.agents = agents
    this.selfId = selfId
    this.config = config
    this.logger = logger
    this.closed = false
    this.systemPrompts = createSystemPromptStore(home)
    // 「reset 到第几代 / 这一代落在哪个 sessionId」的账本：也落盘。
    // 不落盘的后果见 session-state.js 顶上那段 —— 重启即退回 reset 前的老会话 + 每次多一个空壳。
    this.sessionState = createSessionState(home ? join(String(home), 'session-state.json') : '', logger)
    /** 回收前的保留判断（由 sleep 模块注入）：返回 true 就不回收。 */
    this.keeper = null
  }

  get size() {
    return this.#records.size
  }

  start() {
    this.closed = false
    this.#sweeper = setInterval(() => this.#sweep(), 60_000)
    this.#sweeper.unref?.()
    return this
  }

  stop() {
    this.closed = true
    if (this.#sweeper) clearInterval(this.#sweeper)
    this.#sweeper = null
    for (const record of this.#records.values()) {
      record.promptDispose?.()
      if (!record.owned) continue
      try {
        Promise.resolve(record.dispose?.()).catch(() => {})
      } catch (err) {
        this.logger.warn?.('[dsh-qq] 释放会话失败:', err)
      }
    }
    this.#records.clear()
    this.#byPeer.clear()
  }

  find(sessionId) {
    return this.#records.get(sessionId) ?? null
  }

  /** 当前活着的全部会话（主动说话要挨个看一眼谁安静了）。 */
  list() {
    return [...this.#records.values()]
  }

  /**
   * 按 Agent 实例反查记录。
   * `user-questions/request` 的 waterfall 里给的就是 Agent 实例，拿不到可靠的 sessionId 时靠它认人。
   */
  findByAgent(agent) {
    if (!agent) return null
    for (const record of this.#records.values()) {
      if (record.agent === agent) return record
    }
    return null
  }

  /** 按 scope + peerId 找到记录（不算新建）。 */
  findByPeer(scope, peerId) {
    const baseKey = this.#baseKey(scope, peerId)
    const id = this.#byPeer.get(baseKey) ?? this.#byPeer.get(`${baseKey}#${this.#gens.get(baseKey) ?? 0}`)
    return id ? (this.#records.get(id) ?? null) : null
  }

  /**
   * 会话键。开了目录隔离就在结尾加 `@iso`：老会话（当年用公共 cwd 建的）从此不再命中，
   * 保证「一隔离就一定落到自己的目录」，而且换成重启也不会退回老会话去。
   */
  #baseKey(scope, peerId) {
    const key = sessionKey(this.selfId, scope, peerId)
    const isolated = resolvePeerWorkspace(this.config, scope, peerId) !== null
    return isolated ? `${key}@iso` : key
  }

  /**
   * 重置一个 QQ 会话：扔掉当前代理与上下文，下一次消息会开一个全新的会话。
   * 历史记录留在磁盘上但不再被 resume（换了 sessionId）。
   */
  reset(record) {
    const current = this.#records.get(record.sessionId)
    if (!current) return false
    if (current.memoryError) throw new Error('记忆维护进度未能保存，请修复存储后再新建会话；当前会话已保留')
    const snapshot = this.systemPrompts.get(current.sessionId)
    if (snapshot) this.systemPrompts.save({ ...snapshot, retired: true })
    current.promptDispose?.()
    const baseKey = this.#baseKey(current.scope, current.peerId)
    // 代数读内存优先、盘兜底：宿主重启后内存空了，靠盘记住「已经 reset 过一次」
    const next = (this.#gens.get(baseKey) ?? this.sessionState.gen(baseKey)) + 1
    this.#gens.set(baseKey, next)
    this.sessionState.setGen(baseKey, next)
    if (current.owned && current.dispose) {
      try {
        Promise.resolve(current.dispose()).catch(() => {})
      } catch {
        /* ignore */
      }
    }
    this.#records.delete(current.sessionId)
    if (this.#byPeer.get(current.key) === current.sessionId) this.#byPeer.delete(current.key)
    // 上一代那笔账划掉：reset 之后是全新的 sessionId，老 sessions 记录也不会再用上
    this.sessionState.forgetSession(current.key)
    this.logger.info?.(`[dsh-qq] 重置会话 ${current.label}（gen → ${this.#gens.get(baseKey) ?? 0}）`)
    return true
  }

  /** 按 scope + peerId 拿一个可用的会话记录，必要时新建。 */
  async obtain({ scope, peerId, label }) {
    const key = this.#baseKey(scope, peerId)
    if (this.#obtaining.has(key)) return this.#obtaining.get(key)
    const task = this.#obtain({ scope, peerId, label })
    this.#obtaining.set(key, task)
    try { return await task } finally { this.#obtaining.delete(key) }
  }

  async #obtain({ scope, peerId, label }, prepared = null) {
    if (this.closed) throw new Error('dsh-qq 已停止')
    const baseKey = this.#baseKey(scope, peerId)
    const gen = this.#gens.get(baseKey) ?? this.sessionState.gen(baseKey)
    // 第 0 代用原来的 key（保持跟已有历史对齐），之后每 /reset 一次换一个 key
    const key = gen > 0 ? `${baseKey}#${gen}` : baseKey

    const existingId = this.#byPeer.get(key)
    if (existingId) {
      const hit = this.#records.get(existingId)
      if (hit) {
        hit.lastActive = Date.now()
        return hit
      }
      this.#byPeer.delete(key)
    }

    // ⭐ 2026-10-26：先看账本里这一代真正用的 id（换壳兜底过就跟 hash 推出来的不一样），
    // 没有再退回 hash。只用 hash 的话，重启后永远找不着正在聊的那个壳，只会再开一个空的。
    const derived = deriveSessionId(key)
    const sessionId = this.sessionState.sessionId(key) || derived
    const cached = this.#records.get(sessionId)
    if (cached) {
      cached.lastActive = Date.now()
      return cached
    }

    const attached = prepared ?? await this.#attach(sessionId, { scope, peerId, label })
    if (!prepared) {
      try {
        await attached.agent.ctx.get('systemPrompt').assemble(assembleContextFor(attached.agent))
      } catch (err) {
        attached.promptDispose?.()
        if (attached.owned) await attached.dispose?.()
        throw err
      }
    }
    // #attach 可能换了 id（磁盘上留了恢复不出来的空壳会话时），以它实际用的为准
    const actualId = attached.sessionId ?? sessionId
    // 换过壳就记下：下一次重启直接接回这个壳，不再傻乎乎去找那个恢复不了的老 id
    if (actualId !== derived) this.sessionState.setSessionId(key, actualId)
    const record = {
      sessionId: actualId,
      selfId: String(this.selfId),
      key,
      scope,
      peerId,
      label,
      agent: attached.agent,
      dispose: attached.dispose,
      promptDispose: attached.promptDispose,
      owned: attached.owned,
      dir: attached.cwd ?? null,
      lastActive: Date.now(),
      busy: 0,
      queue: Promise.resolve(),
      history: [],
      recent: [],
    }
    this.#records.set(actualId, record)
    this.#byPeer.set(key, actualId)
    const snapshot = this.systemPrompts.get(actualId)
    if (snapshot?.retired) this.systemPrompts.save({ ...snapshot, retired: false })
    this.logger.info?.(`[dsh-qq] 会话就绪 ${label} → ${actualId}`)
    return record
  }

  pendingSystemPrompts() {
    return pendingSystemPrompts(this.systemPrompts, this.config, String(this.selfId))
  }

  /** 先准备新会话，成功后才切换；排队中的消息继续通过同一个 record 投递。 */
  async replaceSession(record) {
    await record.agent.whenIdle()
    await record.outputQueue
    await this.memory?.prepare(record)
    const info = { scope: record.scope, peerId: record.peerId, label: record.label }
    const baseKey = this.#baseKey(record.scope, record.peerId)
    const gen = (this.#gens.get(baseKey) ?? this.sessionState.gen(baseKey)) + 1
    const attached = await this.#attach(deriveSessionId(`${baseKey}#${gen}`), info)
    try {
      await attached.agent.ctx.get('systemPrompt').assemble(assembleContextFor(attached.agent))
      if (!this.reset(record)) throw new Error('会话已被切换，请刷新后重试')
    } catch (err) {
      attached.promptDispose?.()
      await attached.dispose?.()
      throw err
    }
    const queue = record.queue, busy = record.busy
    const next = await this.#obtain(info, attached)
    for (const key of Object.keys(record)) delete record[key]
    Object.assign(record, next, { queue, busy })
    this.#records.set(record.sessionId, record)
    return record
  }

  /**
   * 这个会话自己的目录。_isolateByPeer_ 关掉时返回 null（沿用宿主 cwd）。
   * 首次用到时把 AGENTS.md 与记忆区骨架铺好。
   */
  async #peerDir(info) {
    const dir = resolvePeerWorkspace(this.config, info.scope, info.peerId)
    if (!dir) return null
    if (this.#ready.get(dir)) return dir
    try {
      await ensurePeerWorkspace(dir, info, this.config)
      this.#ready.set(dir, true)
    } catch (err) {
      // 铺不出来就不要把会话钉死在半成品目录上，退回宿主 cwd
      this.logger.warn?.(`[dsh-qq] 初始化会话目录失败 ${dir}:`, err)
      return null
    }
    return dir
  }

  async #attach(sessionId, info) {
    const agentOptions = {}
    if (this.config.provider) agentOptions.provider = this.config.provider
    if (this.config.model) agentOptions.model = this.config.model

    const preset = String(this.config.preset ?? '').trim()
    if (preset && typeof this.ctx?.get?.('agentPresets')?.mount !== 'function') {
      throw new Error(`无法加载 preset '${preset}'：宿主未提供 agentPresets`)
    }
    const cwd = await this.#peerDir(info)
    const metaInfo = { ...info, selfId: String(this.selfId), dir: cwd || this.config.cwd || null }
    // attach 也被只读分类器使用；此处只迁移，不发起维护调用。
    if (this.memory) {
      try { this.memory.store.migrate(metaInfo) }
      catch (err) { this.logger.warn?.('记忆迁移未完成，原文件保留:', err.message) }
    }
    const installPrompt = (agentCtx, agent) => installChatSystem({ agentCtx, agent, config: this.config, meta: metaInfo, store: this.systemPrompts,
      runtimeContext: this.memory ? () => this.runtimeContext(this.findByPeer(info.scope, info.peerId) ?? metaInfo) : null })
    let setupError
    const setup = async (agentCtx, agent) => {
      try {
        if (preset) await this.ctx.get('agentPresets').mount(agentCtx, preset)
        await installPrompt(agentCtx, agent)
      } catch (err) {
        setupError = err
        throw err
      }
    }
    const options = {
      ...(Object.keys(agentOptions).length ? { agentOptions } : {}),
      ...(setup ? { setup } : {}),
    }
    this.logger.debug?.(
      `[dsh-qq] attach ${sessionId.slice(0, 8)} scope=${info.scope} peer=${info.peerId} cwd=${cwd ?? '(null)'}`,
    )

    // 1) 宿主里已经有这个 agent 在跑 → 直接借用（不算我们拥有，别 dispose）
    let live
    try { live = this.agents.get?.(sessionId) } catch {
      /* get 不可用就往下走 */
    }
    if (live && typeof live.followup === 'function') {
      return { agent: live, dispose: null, owned: false, cwd, promptDispose: await installPrompt(live.ctx, live) }
    }

    // 2) 恢复持久化的历史会话
    try {
      const handle = await this.agents.resume({
        resumeSessionId: sessionId,
        ...options,
        ...(cwd ? { meta: { cwd } } : {}),
      })
      if (handle?.agent) {
        this.logger.debug?.(`[dsh-qq] resume 命中 ${sessionId.slice(0, 8)}`)
        return { agent: handle.agent, dispose: () => handle.dispose(), owned: true, cwd, sessionId }
      }
    } catch (err) {
      if (setupError) throw setupError
      // 恢复失败不一定是「没有历史」：也可能是磁盘上留了个半截会话。
      // 把原因打出来，下次再遇到「发消息没反应」能直接看到。
      this.logger.debug?.(`[dsh-qq] resume 未命中 ${sessionId.slice(0, 8)}：${err?.message ?? err}`)
      // ⚠️ 带 meta 的 resume 若被宿主拒绝，退回不带 meta 的老调用（历史会话照旧能起来，
      // 只是工作目录还是它当年那个 —— 发一句 /reset 就会落到新目录）
      if (cwd) {
        try {
          const handle = await this.agents.resume({
            resumeSessionId: sessionId,
            ...options,
          })
          if (handle?.agent) {
            this.logger.warn?.(
              `[dsh-qq] 历史会话 ${sessionId} 沿用旧工作目录，发 /reset 可切到 ${cwd}（原因：${err?.message ?? err}）`,
            )
            return { agent: handle.agent, dispose: () => handle.dispose(), owned: true, cwd, sessionId }
          }
        } catch (err2) {
          if (setupError) throw setupError
          this.logger.debug?.(`[dsh-qq] 退一步 resume 也没成 ${sessionId.slice(0, 8)}：${err2?.message ?? err2}`)
        }
      }
    }

    // 3) 全新会话
    const meta = {}
    const workdir = cwd || this.config.cwd
    if (workdir) meta.cwd = workdir
    if (preset) meta.agentPreset = preset
    const createOptions = {
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      ...options,
    }
    this.logger.debug?.(`[dsh-qq] create ${sessionId.slice(0, 8)} cwd=${workdir ?? '(null)'}`)
    try {
      const handle = await this.agents.create({ sessionId, ...createOptions })
      if (!handle?.agent) throw new Error('agents.create 没有返回 agent')
      return { agent: handle.agent, dispose: () => handle.dispose(), owned: true, cwd: workdir || null, sessionId }
    } catch (err) {
      if (setupError) throw setupError
      // 上一次崩在写会话的那一刻，磁盘上会留一个只有 header 的空壳：
      // 拿这个 id 去 create 会被拒（already exists），resume 又恢复不出东西来，
      // 用户看到的就是「发消息没人回」。这里兜底：再 resume 一次，还不行就换 id 重开。
      const again = await this.agents
        .resume({ resumeSessionId: sessionId, ...options })
        .catch(() => null)
      if (again?.agent) {
        this.logger.warn?.(`[dsh-qq] 会话 ${sessionId.slice(0, 8)} 建不出来，退回 resume 成功`)
        return { agent: again.agent, dispose: () => again.dispose(), owned: true, cwd: cwd ?? null, sessionId }
      }
      const freshId = `${sessionId}-r${Date.now().toString(36)}`
      this.logger.warn?.(
        `[dsh-qq] 会话 ${sessionId.slice(0, 8)} 残留且恢复不了（${err?.message ?? err}），改用新 id ${freshId.slice(0, 16)}`,
      )
      const handle = await this.agents.create({ sessionId: freshId, ...createOptions })
      if (!handle?.agent) throw new Error('agents.create 没有返回 agent')
      return { agent: handle.agent, dispose: () => handle.dispose(), owned: true, cwd: workdir || null, sessionId: freshId }
    }
  }

  #sweep() {
    const baseTtl = Number(this.config.sessionIdleTimeout) || 1_800_000
    // ⭐ 2026-10-25 修：私聊给长得多的闲置期（默认 12 小时）。
    // 原因：主动说话的「安静 20 分钟」和回收的「闲置 30 分钟」只差 10 分钟，
    // 姐姐一忙、会话一回收，wake.tick 就够不着它，一整天都等不到一次主动开口。
    // 群聊保持原值 —— 群里人多、会话便宜回收，没必要常驻。
    const privateTtl = Math.max(baseTtl, Number(this.config.privateIdleTimeout) || 12 * 3_600_000)
    const now = Date.now()
    for (const [sessionId, record] of this.#records) {
      if (record.busy > 0) continue
      const ttl = record.scope === 'private' ? privateTtl : baseTtl
      if (now - record.lastActive <= ttl) continue
      // ⭐ 2026-10-25 修：睡着/攒着消息的会话别回收。
      // 回收后 sleep.tick 和 wake.tick 都只遍历 list()，够不着它 —— 夜里攒的话第二天没人交，
      // 早上也不会主动开口。等睡醒、pending 交完，下一轮 sweep 再正常回收。
      if (this.keeper?.(record)) continue
      if (record.owned && record.dispose) {
        try {
          Promise.resolve(record.dispose()).catch(() => {})
        } catch (err) {
          this.logger.warn?.('[dsh-qq] 回收会话失败:', err)
        }
      }
      record.promptDispose?.()
      this.#records.delete(sessionId)
      if (this.#byPeer.get(record.key) === sessionId) this.#byPeer.delete(record.key)
      this.logger.info?.(`[dsh-qq] 回收闲置会话 ${record.label}`)
    }
  }

  /** 串行化同一个会话里的处理，避免两次 followup 撞在一起。 */
  enqueue(record, task) {
    const run = record.queue.then(async () => {
      record.busy += 1
      record.lastActive = Date.now()
      try {
        await record.outputQueue
        await this.memory?.prepare(record)
        return await task()
      } finally {
        record.busy -= 1
        record.lastActive = Date.now()
      }
    })
    // 吞掉链上的异常，避免污染后续任务
    record.queue = run.catch(() => {})
    return run
  }
}
