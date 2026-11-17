# 开发

本文维护开发环境、代码结构和开发约定。完成状态、执行顺序与待办统一见[开发进度与计划](progress.md)。

## 本地开发

```bash
pnpm install --ignore-scripts
node test/e2e.mjs      # 假 NapCat + 假宿主，跑完整链路（不需要真 QQ）
```

不启动 DSH 的网页模拟器：`pnpm dev:mock`；自动化场景：`pnpm test:mock`。覆盖范围和编排方式见 [本地模拟环境](mock-environment.md)。

`test/mock-napcat.mjs` 也能单独当调试工具用：

```bash
node test/mock-napcat.mjs --port 3001 --token my-token-2026
# 然后在标准输入敲一行 JSON，就当作 QQ 推来一条事件
```

测试的边界、覆盖到哪、哪些只能手测，见 [TESTING.md](../TESTING.md)。

记忆行为与旧数据迁移见[记忆整理方案](memory-design.md)；官方循环接入见[末尾状态区](host-transient-context.md)；情绪功能范围和接入约束见[情绪系统设计](emotion-system-development.md)。

模型工具的说明、返回、错误与续读约定见[工具设计规范](tool-design.md)；现有工具和整理决定见[QQ 工具清单](tool-cleanup-plan.md)，参考资料工具的具体行为见[参考资料](knowledge.md)。

## 目录

```
src/
├── index.js           插件入口（apply）
├── config.js          schemastery 配置
├── prompts.js         聊天规矩 / persona 拼装（中性默认，不含任何私人设定）
├── session.js         会话管理（QQ 会话 ↔ DSH Agent）
├── workspace.js       聊天工作目录隔离与旧模板迁移，不再生成 AGENTS.md
├── inbound.js         QQ 消息 → agent.followup（含语音转写、图片落盘、引用还原）
├── outbound.js        session/event → QQ 消息
├── tools.js           QQ 工具注册入口，按职责分模块
├── knowledge.js       参考资料来源、检索与原文读取
├── faces.js           表情包收藏夹（扫描 / 收藏 / 归一化）
├── questions.js       ask_user_question → QQ 问答通道
├── approval.js        授权审批 → QQ 问答通道
├── onebot/client.js   OneBot WebSocket 客户端（自动重连）
├── onebot/segment.js  消息段 / CQ 码解析
└── shared/chunk.js    长文本切块

client.js              设置页（uiOnly 时只挂这一层）
tools/
└── asr.py             离线语音识别脚本（vosk，可选，不装也能跑其它功能）
docs/                  说明文档
test/                  e2e 与 mock
```

## 设置页是怎么接上的

同一个设置页要能在两种宿主里都活着，所以有两条路：

| 路 | 说明 |
| --- | --- |
| ① 宿主路由 `/api/dsh-qq` | `ctx.inject(['webServer'], …)` 运行时注入；拿到就挂 |
| ② 本地服务 `127.0.0.1:<localApiPort>` | 默认端口 `34569`；设为 `0` 可关闭。多实例用不同端口，设置页顶部可指定目标端口 |

本地服务只监听回环地址，CORS 放开是为了让 DSH 页面能跨端口读。`headless` 宿主（`--profile qqbot`）没有网页服务，所以它不会起 ②，也不影响 QQ。

**踩过的坑**：`ctx.effect` 必须挂在长命的父 ctx 上。挂到注入回调的子 ctx 上，回调一结束就被收走——现象是 `api-state.txt` 写着 `ok=true`，前端却一直 404。

## 两条约定

1. **`src/` 里不许出现私人东西**：真实 QQ 号、群里的梗、私人称呼。那些属于配置层的 `persona` / `ownerIds` / `directPrompt`。测试里一律用假号（`10001`、`88888` 这种）。
2. **改行为先核对设计与实际调用链**：消息交付见[群消息设计](group-message-design.md)，提示词与身份见[人设说明](persona.md)，辅助脚本见[脚本说明](../tools/README.md)。历史调研用于解释来源，不能据此恢复已退役行为。
