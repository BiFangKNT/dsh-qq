# 不启动 DSH 的本地模拟环境

在仓库目录运行：

```powershell
pnpm install --ignore-scripts
pnpm dev:mock
```

打开终端打印的本地网址。端口默认由系统分配；指定端口用 `pnpm dev:mock --port 3100`。加 `--verbose` 可同时在终端查看插件日志。Ctrl+C 关闭。

网页可以模拟私聊、群聊、@、发图，查看插件的实际入站提示词、工具结果、QQ 回复、空间说说和日志；设置编辑器调用插件本身的设置 API。故障按钮可以让下一次 API 返回失败、断开 WebSocket 或重载插件。

点击“打开正式设置页预览”，或访问同一地址的 `/settings`，可预览实际 `client.js` 设置组件，切换浅色/深色并保存配置。React 和 ReactDOM 从本地开发依赖加载，无需 CDN 或额外构建。预览与消息模拟器共用同一后端：先发送一条模拟消息，再修改人设，即可测试“创建新会话 / 压缩会话 / 强制同步 / 稍后同步”。页面仅允许连接当前模拟器，不能通过独立设置端口访问真实实例。外层容器只模拟基础配色，真实 DSH 的外壳和主题仍需集成验证。

不需要 DSH 桌面端、DSH CLI、QQ、NapCat、模型 API key 或容器。仍需安装本仓库的 Node 依赖：插件本身使用的消息工厂和配置校验来自 DSH 的轻量库，导入库不会启动 DSH。

## 模拟范围

| 边界 | 实现 |
| --- | --- |
| 插件 | 加载真实 `src/index.js`，执行真实配置、门控、媒体下载、工具、聊天流水、上下文守卫与清理 |
| DSH 宿主 | 服务查找、事件总线、waterfall、effect/inject、工具注册、Agent create/resume、setup 预设挂载、消息注入、whenIdle、会话持久化与恢复 |
| 模型 | 默认固定回复；可用步骤数组模拟流式正文、工具调用、用量、压缩、问答、审批和报错 |
| 预设 | 仅提供 `mock` 预设；含限制在会话目录内的 read/write/edit 和读取图片文件的 read_image |
| NapCat | 真实回环 WebSocket、token 鉴权、消息与引用存储、合并转发、语音夹具、收发/撤回/表情回应/点赞/戳一戳/文件上传/空间接口 |
| 媒体 | 通过本地 HTTP 提供 PNG、WAV 夹具，不需要外部图片服务 |
| 故障 | API 失败、延迟、丢回执、已执行但丢回执、断线与重连；未知接口明确报错 |

模拟目录由系统临时目录下的 `dsh-qq-sim-*` 独立生成；界面显示具体路径。重载会保留这个目录，用于验证恢复；退出也保留，便于检查日志。不会读取你的真实 DSH 家目录，也不启动独立设置服务（`localApiPort=0`），设置请求只走模拟器自己的路由。连接地址、账号和主要落盘路径固定为模拟环境，不能从设置页改到真实 NapCat。

**边界**：这不是 DSH 或 NapCat 的完整替代实现。它验证插件使用的接口及行为，不能证明真实模型的推理、视觉识别、QQ 风控、空间实际发布或不同宿主版本的兼容性。`read_image` 只返回测试文件信息；Windows 语音合成仍使用本机 SAPI，离线 ASR 仍需要真实识别依赖。模拟审批从不执行真实命令。

模拟宿主提供官方快照及消息替换的状态生命周期，方便预览设置与查看当前状态；不会自动识别真实事项的完成。记忆生命周期用固定维护响应验证；真实 DSH 发布循环的接口测试另见[官方循环接入与验证范围](host-transient-context.md)。

## 编排模型行为

展开网页的“为这一轮编排模型行为”，填 JSON 步骤后发送一条消息。步骤被下一轮实际投递的消息消耗；被访问控制或 @ 门挡住的消息不会消耗步骤。发送后编辑框会清空，回答问答和审批时可直接再发普通消息。

```json
[
  { "type": "context", "window": 128000 },
  { "type": "tool", "name": "qq_send", "args": { "text": "工具发送的测试回复" } },
  { "type": "text", "text": "这段不应再次自动发送" }
]
```

支持的步骤：

- `text`：正文；可附 `usage: {inputTokens, cacheReadTokens, outputTokens}`。
- `chunk`：流式文本增量（需打开插件 `streamReply`）。
- `tool`：调用已注册的真实 QQ 工具或 mock 预设工具。
- `context`：上报模型窗口；`compact`：模拟压缩结束。
- `error`：以 `message` 指定的错误结束本轮，例如 `CONTEXT_WINDOW_EXCEEDED`。
- `question`：`questions` 与插件问答通道使用同一结构，网页有示例按钮。
- `approval`：展示 `command` 并等待“通过/拒绝/取消”，不会执行该命令。

工具的失败会写入真实形状的 `tool/result` 与 `turn/end`，不会假装成功。空间等工具只会访问模拟 NapCat；可在右侧看到 API 调用及模拟发布结果。

## 自动化验证

```powershell
pnpm test:mock   # 新模拟环境的端到端场景
pnpm test:e2e    # 原有完整链路场景
pnpm test        # 所有 *.test.mjs，包括新模拟环境
```

也可在测试中导入 `createMockEnvironment`、`waitFor`，控制真实插件而不启动网页浏览器：

```js
import { createMockEnvironment } from './mock-environment.mjs'
import { waitFor } from './mock-dsh.mjs'

const env = await createMockEnvironment()
try {
  env.host.queueTurn([{ type: 'text', text: '预期回复' }])
  env.emitMessage({ text: '模拟入站', peerId: 11001 })
  await waitFor(() => env.napcat.calls.some(c => c.action === 'send_private_msg'))
  console.log(env.snapshot())
} finally {
  await env.close()
}
```

`env.napcat.failNext(action, {afterApply: true, drop: true})` 可模拟“服务端已处理，回执丢失”；`setForward(id, messages)` 和 `setRecord(id, response)` 用来准备合并转发、语音夹具。测试自动生成并清理自己的临时目录。
