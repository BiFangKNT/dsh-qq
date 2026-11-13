import Schema from '@deepseek-ai/schemastery'

/**
 * dsh-qq 配置。
 *
 * 设计原则：
 *  - 所有跟「连谁、允许谁说话、放开到什么程度」有关的键，默认都是保守的；
 *  - provider / model / preset / cwd 一律留空跟随宿主，避免把某个人的环境写死。
 */
/**
 * 把一个「本该是数组」的配置值安全地取成字符串数组（issue #3）。
 *
 * 为什么要有它：`privateAllow` / `groupAllow` 既能写在 settings.json 里，也能写在
 * profile 的 `cordis.patch.yml` 里，人把它写成 `"123456"` 这种单个字符串是常事。
 * 原来的写法 `(config.privateAllow ?? []).map(...)` 会直接抛
 * `TypeError: (c.privateAllow ?? []).map is not a function`，而且抛出点在入站处理
 * 深处、离配置项很远，用户只能看到「消息没反应」，看不出是自己少写了方括号。
 *
 * 规则：数组照收；字符串按逗号 / 中文逗号 / 空白拆；数字当单个号；其余（null、
 * undefined、对象、布尔）一律当空。每项 trim 后丢掉空串，所以 `"a, ,b"` 也能用。
 */
export function listOf(v) {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
  if (typeof v === 'number' || typeof v === 'bigint') return [String(v)]
  return []
}

export const ConfigSchema = Schema.object({
  // ── 连接 ──
  wsUrl: Schema.string()
    .default('')
    .description(
      'NapCat（或其它 OneBot 11 实现）的正向 WebSocket 地址，例如 ws://127.0.0.1:3001。' +
        '留空就不连接——不会偷偷去连 3001，启动时会在日志里提示去哪配',
    ),
  accessToken: Schema.string()
    .default('')
    .description('与 NapCat 配置里一致的 access token，留空表示不鉴权（仅建议在本机回环场景）'),
  selfId: Schema.string()
    .default('')
    .description('机器人自己的 QQ 号。留空时启动会向 NapCat 查询 get_login_info'),
  reconnectMs: Schema.number()
    .default(5000)
    .description('断线重连间隔，单位毫秒'),

  localApiPort: Schema.number().min(0).max(65535).step(1)
    .default(34569)
    .description('独立设置服务的回环端口；0 = 关闭独立服务，仍可使用宿主设置路由。多实例请用不同端口，修改后重启宿主'),
  acceptedDshVersions: Schema.dict(Schema.string()).default({})
    .description('明确接受风险的 DSH 核心包版本。通常由确认弹窗填写；版本变化后重新确认。无界面部署可复制运行端 host-compatibility.json 的 versions 对象'),

  // ── Agent ──
  provider: Schema.string().description('LLM provider 名称；留空跟随宿主默认'),
  model: Schema.string().description('模型名；留空跟随宿主默认'),
  preset: Schema.string().description('Agent 预设 ID；留空加载宿主默认预设。新会话生效，已有会话恢复原预设；宿主未启用预设服务时留空使用全局组合'),
  cwd: Schema.string().description('Agent 工作目录；留空使用宿主默认'),
  uiOnly: Schema.boolean()
    .default(false)
    .description(
      '只提供 DSH 设置界面里的那一页，不连接 NapCat、不起会话。桌面 / Web 那份装一份、配成 true，就是纯设置面板；QQ 本体跑在另一个 profile 里，不然同一个号两处登录会抢消息',
    ),
  workspaceRoot: Schema.string()
    .default('')
    .description('每个 QQ 会话的独立工作目录放在哪里；留空用 <cwd>/会话'),
  faceRoot: Schema.string()
    .default('')
    .description(
      '表情包收藏（`表情包收藏.json` + `表情包/`）放在哪个目录。多个 QQ 会话填同一个路径就是共用一套收藏；留空则跟 `workspaceRoot` 走（各存各的）',
    ),
  isolateByPeer: Schema.boolean()
    .default(true)
    .description('每个私聊、群聊使用独立工作目录；关闭后共用宿主工作目录。统一记忆另按聊天身份隔离。修改后重启运行 QQ 的宿主'),
  memoryRoot: Schema.string()
    .default('')
    .description(
      '共享文件目录；留空禁用 qq_memo。获准聊天可读，仅授权账号私聊可写，只支持 md/txt。与按聊天隔离的统一记忆分开；修改后重启宿主。',
    ),
  persona: Schema.string()
    .default('')
    .description(
      '角色设定：它是谁、什么性格、怎么称呼对方。留空则是一只没有名字、说话正常的普通助手——插件不会自带任何人的私人设定',
    ),
  personaFile: Schema.string()
    .default('')
    .description(
      '人设文件路径（比如 D:/某个角色.md）。填了就从这个文件读人设，覆盖上面的 persona；文件读不到时保留 persona，不会把角色弄丢',
    ),
  personaInSystem: Schema.boolean()
    .default(false)
    .description(
      '人设已由宿主 system-prompt 的 personaPrefix 提供时设 true，避免重复添加 persona。false 时插件将 persona 放进 system；固定 system 只在新建会话或成功压缩后更新',
    ),
  ownerIds: Schema.array(Schema.string())
    .default([])
    .description(
      '授权账号的 QQ 号，可多个。用于相关工具的权限检查，不改变称呼、关系或回复顺序',
    ),
  ownerLabel: Schema.string()
    .default('')
    .description('已停用，仅供迁移旧配置；改用 memberLabels 按账号设置称呼'),
  memberLabels: Schema.dict(Schema.string()).default({})
    .description('QQ 号对应称呼，群聊和私聊通用；不设置时用昵称、群名片或「你」，与授权名单无关'),
  directPrompt: Schema.string()
    .default('')
    .description('私聊 system 的补充提示词，按会话的 system 同步规则生效'),
  groupPrompt: Schema.string()
    .default('')
    .description('群聊 system 的补充提示词，按会话的 system 同步规则生效'),
  aiGirls: Schema.boolean()
    .default(true)
    .description(
      '把「AI 娘图鉴」夹进提示词：群友说到 DeepSeek 娘、龙娘、通义娘这些同人角色时认得出来，不会当成真人或瞎猜。大约多几百字，嫌占地方可以关掉',
    ),
  historyLimit: Schema.number()
    .default(20)
    .description('群聊时额外带入的最近消息条数（0 = 不带历史）'),
  quoteReply: Schema.boolean()
    .default(true)
    .description('收到的消息带引用时，把「被引用的人 + 原文」一并交给 Agent'),
  maxTurnMs: Schema.number()
    .default(600000)
    .description('单轮回复最长等待时间，单位毫秒（默认 10 分钟；超时只提示，不打断 Agent）'),

  // ── 触发策略 ──
  addressClassifierEnabled: Schema.boolean().default(false)
    .description('使用独立模型会话判断是否在和机器人说话；跳过的消息保留，下次放行时一起提供'),
  addressClassifierProvider: Schema.string().default('')
    .description('前置分类器 provider；留空使用插件明确配置的 provider，不能自动读取宿主默认'),
  addressClassifierModel: Schema.string().default('')
    .description('前置分类器模型；留空使用插件明确配置的 model'),
  addressClassifierReasoningEffort: Schema.string().default('low')
    .description('前置分类器推理强度，由所选模型支持的值决定'),
  addressClassifierTimeoutMs: Schema.number().min(1).default(30000)
    .description('前置分类超时毫秒；失败保留消息并记录错误，等待后续消息放行'),
  requireMention: Schema.boolean()
    .default(true)
    .description('群聊必须通过协议消息段 @ 自身才启动主模型；分类器、引用和名字不能绕过'),
  groupMentionOverrides: Schema.dict(Schema.boolean()).default({})
    .description('按群覆盖必须 @：群号对应 true 为必须 @，false 为免 @；未列出的群沿用全局设置'),
  groupMessageIntervalMs: Schema.number().min(1).default(30000)
    .description('免 @ 且未开启分类器时，从第一条消息起等待多久合并处理（毫秒）；自身 @ 或触发词可提前处理'),
  groupTriggerWords: Schema.array(Schema.string()).default([])
    .description('免 @ 且未开启分类器时，当前消息文字包含任一触发词则立即处理；区分大小写，不匹配引用或历史，仍允许沉默'),
  groupFree: Schema.array(Schema.string()).default([]).hidden()
    .description('已退役：启动时迁移到 groupMentionOverrides'),
  groupImageBlock: Schema.array(Schema.string())
    .default([])
    .description('主会话按群成员屏蔽图片：「群号:QQ号」屏蔽全部；「群号:QQ号:宽x高」仅屏蔽指定尺寸（如 123456789:10001:1920x1080，宽高精确匹配）。命中后不写入主会话图片缓存，只保留文字和 [图片]。分类器不受此限制，开启后仍可下载并看图；分类器关闭时全图屏蔽不下载'),
  addressedMaySilent: Schema.boolean()
    .default(false)
    .description(
      '群里被协议消息段 @ 时也允许沉默（默认 false）。只影响本轮是否允许沉默，不绕过群聊触发条件',
    ),
  replyToPrivate: Schema.boolean()
    .default(true)
    .description('是否响应私聊'),
  groupMode: Schema.union(['open', 'allowlist', 'disabled'])
    .default('open')
    .description('群聊访问控制：open 全部 / allowlist 仅白名单 / disabled 关闭群聊'),
  groupAllow: Schema.array(Schema.string())
    .default([])
    .description('groupMode=allowlist 时生效的群号列表'),

  // ── 同类机器人（机器人和机器人之间）──
  // 用户 2026-10-24：「吵架功能单独做个开关，这个开关控制它要不要和同类聊天，以及对比较冲的同类回怼」。
  botChatEnabled: Schema.boolean()
    .default(false)
    .description('群里另一个机器人说话时要不要接（关着 = 同类说啥都不理，连 @ 也不接）'),
  peerBots: Schema.array(Schema.string())
    .default([])
    .description('已知的同类机器人 QQ 号；填了才认得出「这句是别的机器人发的」（NapCat 也带 is_robot 时同样认）'),
  // 2026-10-29 姐姐：「有没有办法能做到能私聊，但是能停下」——同类连着聊的刹车。
  // 私聊里两只鲸鲸互相回话没有天然终点：A 回 B，B 又回 A，每轮都算「有人跟我说话」，
  // 出站限流只能把它压慢、停不下来。这个数字是「连着接几轮就先不接」；真人一开口就清零。
  peerChatMaxTurns: Schema.number()
    .default(0)
    .description(
      '同类机器人连着聊最多接几轮（0 = 不限制）；超过就先不投递、只留痕，真人一开口就清零。' +
        '私聊互通时靠它自动散场，不用人盯着关',
    ),
  privateMode: Schema.union(['open', 'allowlist', 'disabled'])
    .default('allowlist')
    .description(
      '私聊访问控制：allowlist 仅白名单（默认；白名单空着 = 谁都不理）/ open 谁都能聊 / disabled 关闭私聊。' +
        '默认不再放行陌生人：能私聊这个号的人，就能指挥跑在你机器上的 agent',
    ),
  privateAllow: Schema.array(Schema.string())
    .default([])
    .description('privateMode=allowlist 时生效的 QQ 号列表；空着就谁都不理'),

  // ── 主动说话的「冷会话拉回」（2026-10-25 加）──
  // 会话闲置太久会被回收出内存；主动说话轮只看得见内存里的会话，
  // 冷掉之后就永远不会主动开口了。开着 = 每轮先把它拉回来。
  wakeColdSessions: Schema.boolean()
    .default(false)
    .description(
      '主动说话前把白名单里的私聊会话拉回内存（关着 = 只有对方先说话，这个会话才会被主动说话轮看见）',
    ),
  wakeColdMax: Schema.number()
    .default(3)
    .description('每次最多拉回几个冷会话（防止一次唤醒太多、吃内存和 token）'),

  // ── 回收（2026-10-25 修）──
  // 私聊的「安静 20 分钟」和「闲置 30 分钟回收」只差 10 分钟，
  // 姐姐一忙、会话一回收，主动说话轮就够不着它，一整天等不到一次主动开口。
  // 群聊保持 sessionIdleTimeout 原值（人多、会话便宜回收）。
  privateIdleTimeout: Schema.number()
    .default(12 * 3_600_000)
    .description('私聊会话闲置多久回收出内存，单位毫秒，默认 12 小时；群聊仍用 sessionIdleTimeout'),

  // ── 图片 ──
  faceCollectHint: Schema.string()
    .default('')
    .description(
      '什么样的图值得收进表情包收藏（qq_keep_face），例如「猫猫梗图」。留空表示不收藏任何图片，只让 Agent 看图说话',
    ),
  faceSendGapMs: Schema.number()
    .default(90000)
    .description('两次发图片/表情之间至少隔多少毫秒（防止刷屏）；0 = 不限制'),
  faceSendMaxPerHour: Schema.number()
    .default(6)
    .description('一小时内最多发多少张图片/表情（qq_mface / qq_send_image 合计）；0 = 不限制'),
  imageCacheDir: Schema.string()
    .default('')
    .description('收到的图片下载到哪个目录；留空用 <cwd>/图片缓存'),
  imageMaxMB: Schema.number()
    .default(8)
    .description('单张图片最大体积（MB），超过就丢弃不下载'),

  // ── 工具：查梗 ──
  memeDb: Schema.string()
    .default('')
    .description(
      '查梗用的词库（cnmeme.wiki 的 sqlite 快照）放在哪；留空则读环境变量 DSH_QQ_MEME_DB。' +
        '两个都空时 qq_meme 会说明「没配词库」，不会瞎猜出处',
    ),

  // ── 语音转文字（离线 vosk） ──
  voiceName: Schema.string().default('').description('Windows SAPI 声音名称，留空使用系统默认声音'),
  asrEnabled: Schema.boolean()
    .default(true)
    .description('收到语音时用本地 vosk 离线转成文字（不需要联网）'),
  asrPython: Schema.string()
    .default('python')
    .description('运行 ASR 脚本的 python 可执行文件；默认要求 python 在 PATH 里，且装过 vosk + numpy'),
  asrScript: Schema.string()
    .default('')
    .description('ASR 脚本路径；留空使用插件自带的 tools/asr.py'),
  asrModel: Schema.string()
    .default('')
    .description('vosk 模型目录（必须是纯 ASCII 路径）；留空由 asr.py 自己找，也可用环境变量 VOSK_MODEL'),
  asrTimeoutMs: Schema.number()
    .default(60000)
    .description('单条语音转文字的超时时间，单位毫秒'),

  // ── 输出 ──
  textChunkLimit: Schema.number()
    .default(1500)
    .description('单条消息最大字数，超出会按段落/句号切成多条发'),
  showToolResults: Schema.boolean()
    .default(false)
    .description('是否把工具调用结果也发到 QQ（默认关闭，只发文字回复）'),
  splitDelayMs: Schema.number()
    .default(400)
    .description('分条固定间隔，单位毫秒；仅在 splitDelayMeanMs 为 0 时使用'),
  replyDelayMeanMs: Schema.number()
    .default(500)
    .description('收到消息后隔多久才开口，单位毫秒、指数分布均值（0 = 立刻回）。真人不会在同一毫秒回话；同一轮连发不重复等，隔 20 秒以上才算新的一轮'),
  splitDelayMeanMs: Schema.number()
    .default(500)
    .description('分条随机间隔均值，单位毫秒；0 表示使用 splitDelayMs 的固定间隔'),
  rateLimitPerMin: Schema.number()
    .default(12)
    .description('每个会话每分钟最多发几条（0 = 关闭）。QQ 对高频回复很敏感，被限流甚至被封往往不是因为说了什么，而是因为回得太多'),
  auditOutbound: Schema.boolean()
    .default(true)
    .description('发送前在本地检查已配置的 NapCat 令牌和少量明确的密钥格式；命中后阻止原文，发送固定提示。默认不拦路径，不调用模型'),
  auditExtraPatterns: Schema.array(Schema.string())
    .default([])
    .description('额外敏感内容正则（字符串形式），命中后阻止原文并发送固定提示；配错的正则会跳过'),
  groupMinGapMs: Schema.number()
    .default(4000)
    .description('群聊里两条回复之间至少隔多久，单位毫秒（0 = 不限制）。群里连着追问时，隔开一点比一口气说完安全得多'),
  streamReply: Schema.boolean()
    .default(true)
    .description('私聊是否边生成边发（群聊始终整段发）'),
  streamMaxChunks: Schema.number()
    .default(3)
    .description('一个回合里最多流式发几条，超出就攒起来一起发'),

  // ── 主动说话 ──
  proactiveEnabled: Schema.boolean()
    .default(false)
    .description('启用后，会话安静到指定时长时调用主模型决定是否主动发言；默认关闭，模型选择沉默仍产生调用'),
  proactiveSilentMs: Schema.number()
    .default(1200000)
    .description(
      '会话安静多久算「冷场」，单位毫秒，默认 20 分钟。要小于 sessionIdleTimeout（默认 30 分钟），否则会话先被回收、根本没机会开口',
    ),
  proactiveMaxPerDay: Schema.number()
    .default(6)
    .description('每个聊天每天成功主动发言的上限；重启或换会话不重置，0 = 不主动'),
  proactiveQuietHours: Schema.string()
    .default('23:00-08:00')
    .description('静默时段：这段时间不主动开口。格式 HH:MM-HH:MM，留空 = 不限'),

  // ── 作息（睡前提醒 / 晚安静默 / 夜里消息留到早上） ──
  sleepMode: Schema.boolean()
    .default(true)
    .description('控制睡前提醒和休息限制；关闭后继续交付已有私聊积压'),
  bedtimeAt: Schema.string()
    .default('23:30')
    .description('私聊睡前提醒时间（HH:MM）；调用主模型，每天至多一次，只补发30分钟内的提醒。留空关闭提醒'),
  sleepFrom: Schema.string()
    .default('00:00')
    .description('休息时段从几点开始（HH:MM）：这时候起收到的私聊不立刻回'),
  sleepTo: Schema.string()
    .default('08:00')
    .description('休息时段到几点结束（HH:MM）：这时候把夜里攒的消息一次交出去'),
  groupSleepFrom: Schema.string().default('').description('群聊休息开始（HH:MM），留空沿用 sleepFrom'),
  groupSleepTo: Schema.string().default('').description('群聊休息结束（HH:MM），留空沿用 sleepTo'),
  privateSleepFrom: Schema.string().default('').description('私聊休息开始（HH:MM），留空沿用 sleepFrom'),
  privateSleepTo: Schema.string().default('').description('私聊休息结束（HH:MM），留空沿用 sleepTo'),
  goodnightWords: Schema.string()
    .default('晚安,睡了,睡觉,去睡,我先睡,困了,睡啦')
    .description('作息与休息限制都开启时，私聊短句匹配这些词后休息到 privateSleepTo；晚安本身照常回应。逗号分隔'),
  // ⭐ 2026-10-25：默认不按住——姐姐半夜说话通常就是她醒了，正常回。
  // 想让她「夜里真的静音、消息留到早上」的话，把这个打开。
  holdNightMessages: Schema.boolean()
    .default(false)
    .description(
      '启用休息时段静默：私聊攒到醒来后回复，群聊直接略过；关着则照常回应',
    ),

  // ── 连发合并 ──
  mergeWindowMs: Schema.number()
    .default(5000)
    .description(
      '连发合并：收到一条私聊消息后等这么久（毫秒），期间再接到的消息并成同一轮再回；0 = 关掉，来一条回一条',
    ),

  // ── 上下文管理 ──
  contextGuard: Schema.boolean()
    .default(true)
    .description('记录上下文使用与压缩情况；正常长聊由 DSH 自动压缩，不主动换会话'),
  memoryProvider: Schema.string().default('').description('记忆维护 provider；留空沿用当前主会话模型路由'),
  memoryModel: Schema.string().default('').description('记忆维护模型；留空沿用当前主会话模型'),
  memoryTimeoutMs: Schema.number().min(1).default(30000).description('记忆维护最长等待毫秒数'),
  memoryTaskTtlHours: Schema.number().min(1).default(24).description('没有明确期限的事项多久无新证据转为待核实（小时）'),

  // ── 聊天流水 ──
  chatLog: Schema.boolean()
    .default(true)
    .description(
      '把收发原文额外记进会话目录的 聊天记录/<日期>.md；不控制宿主历史和统一记忆',
    ),

  // ── 生命周期 ──
  sessionIdleTimeout: Schema.number()
    .default(1800000)
    .description('会话闲置多久后回收，单位毫秒（默认 30 分钟）'),
  debug: Schema.boolean()
    .default(false)
    .description('输出调试日志'),
})
