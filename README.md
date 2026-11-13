# dsh-qq-onebot

通过 OneBot v11 将 QQ 私聊和群聊接入 DeepSeek Harness（DSH）的插件，支持 Agent 会话、图片与语音处理、QQ 互动工具，以及问答和审批消息转发。

本仓库是 [2710586329/dsh-qq](https://github.com/2710586329/dsh-qq) 的 fork。下文以本仓库源码为准；安装上游发布的同名 npm 包不代表包含本 fork 的修改。

```text
QQ ↔ OneBot v11 协议端（如 NapCat）↔ dsh-qq-onebot ↔ DSH Agent
```

## 功能

- **私聊与群聊接入**：访问名单、群聊 @ 触发、连续对话窗口和回复频率控制。
- **会话管理**：按私聊对象或群组建立持久会话，支持独立工作目录和记忆文件、上下文管理与会话恢复。
- **提示词同步**：固定 system 在会话内锁定，修改设置后可选择新建会话、压缩会话、强制同步或稍后同步。
- **多媒体**：接收图片、本地离线语音识别，以及图片、文件和语音发送；部分功能需要额外依赖或平台支持。
- **QQ 工具**：发送、引用和撤回消息，戳一戳、表情回应、点赞等。
- **交互转发**：将 Agent 的提问和审批请求转发到 QQ，并接收用户答复。
- **配置界面**：通过 DSH 设置页或本地配置文件管理插件。
- **本地模拟器**：不连接真实 QQ 即可验证消息流程、工具调用和故障处理。

角色设定、共享文件、主动消息和作息等均为可配置能力，不要求使用特定角色、模型或个人部署方案。完整选项见 [配置参考](docs/configuration.md)。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| DeepSeek Harness | `package.json` 声明要求 ≥ 0.2.0；实际兼容性需在目标宿主验证 |
| Node.js | 本地开发要求 ≥ 26；插件运行时使用 DSH 内置的 Node.js |
| OneBot 协议端 | 提供 OneBot v11 正向 WebSocket 服务，例如 NapCat |
| pnpm | 安装源码依赖、运行模拟器和测试时使用 |
| 可选语音依赖 | 接收语音转写需要 Python、vosk、numpy 和识别模型；语音合成使用 Windows SAPI |

插件不包含 QQ 协议端或模型服务。真实回复使用 DSH 中配置的模型和工具；模拟器使用固定回复或编排步骤。

## 安装本 fork

克隆本仓库并安装依赖：

```powershell
git clone https://github.com/BiFangKNT/dsh-qq.git
cd dsh-qq
pnpm install --ignore-scripts
```

完全退出目标 DSH 宿主后，使用其提供的 `dsh` 命令安装本地目录：

```powershell
# 在仓库目录执行；desktop 为目标 profile，按实际部署替换
$pluginPath = (Get-Location).Path
dsh plugin --profile desktop add "$pluginPath"
```

桌面端的 `desktop` profile 应使用桌面安装附带的 CLI 管理。安装完成后重新启动 DSH。可用以下命令检查安装来源：

```powershell
dsh plugin --profile desktop why dsh-qq-onebot
```

本 fork 沿用上游包名 `dsh-qq-onebot`；安装或更新时请确认加载的是预期的源码目录。

## 连接与最小配置

### 1. 配置 OneBot 协议端

在协议端启用 **正向 WebSocket 服务**，使用数组格式的消息段，并设置访问令牌。例如，本机服务可监听 `127.0.0.1:3001`。具体安装和登录步骤请参阅所用协议端的文档。

### 2. 配置插件

在 DSH 的 **设置 → QQ** 中填写连接信息和访问名单，也可编辑 `$DSH_HOME/dsh-qq/settings.json`。未设置 `DSH_HOME` 时，默认位置为 `~/.dsh/dsh-qq/settings.json`。

下面使用虚构账号演示仅允许指定私聊、关闭群聊的最小配置：

```json
{
  "wsUrl": "ws://127.0.0.1:3001",
  "accessToken": "REPLACE_WITH_YOUR_TOKEN",
  "privateMode": "allowlist",
  "privateAllow": ["10001"],
  "groupMode": "disabled"
}
```

将令牌替换为协议端设置的值，将 `10001` 替换为允许访问的 QQ 号。保留配置文件中需要继续使用的其他键。

需要群聊时，可将 `groupMode` 设为 `allowlist`，并配置 `groupAllow`；群聊默认需要 @ 机器人。`ownerIds` 是授权账号名单，用于部分工具的权限判断，不能代替 `privateAllow`。称呼通过 `memberLabels` 按账号单独配置，不随授权身份继承，详见[人设与称呼](docs/persona.md)。

### 3. 验证消息收发

保存设置，按界面提示重连或重启宿主。确认日志显示连接成功后，使用名单中的账号发送私聊，检查 Agent 回复。

## 在 DSH 设置里调它

设置页与 `settings.json` 管理的是同一份用户覆盖配置，显式设置的键会覆盖 profile 配置。删除覆盖键后使用 profile 或默认值；设置页不会改写 profile 的 `cordis.patch.yml`。

大部分配置支持热更新；连接参数可通过「重连」应用。`localApiPort`、`reconnectMs`、`selfId`、`workspaceRoot`、`isolateByPeer`、`asrPython` 的变更需要重启宿主。

以下默认行为需要在接入前确认：

| 项目 | 默认行为 |
| --- | --- |
| 连接 | `wsUrl` 为空，不连接协议端 |
| 私聊 | `privateMode: allowlist`，`privateAllow: []`，不接受任何私聊 |
| 群聊 | `groupMode: open`，默认需要 @；可改为名单模式或关闭 |
| 工作目录 | `isolateByPeer: true`，按私聊对象或群组分目录；默认位于 `<cwd>/会话` |
| 模型与预设 | 未指定时跟随宿主；新会话加载默认预设，已有会话保留原预设。QQ 设置页可填写“Agent 工具预设” |
| 主动消息 | 默认关闭；设置 `proactiveEnabled: true` 后启用，受静默时段和次数限制；模型选择沉默仍产生调用 |
| 消息与容量 | 按聊天持久保存原文和处理进度；不重复补最近 N 条。积压超窗先压缩已有历史，再左截断旧积压；未提供原文可回查。原文及受保护附件会持续占用本地磁盘，详见[保存与容量说明](docs/group-message-design.md#第-3-批实际实现) |
| 聊天流水 | `chatLog: true`，保存聊天记录；按部署需要决定是否关闭 |

目录划分用于组织会话与文件；实际文件和命令访问权限仍取决于宿主、预设及工具配置。

当前版本使用未修改的 DSH **0.2.2-rc.2**，通过官方接口接入[末尾状态区](docs/host-transient-context.md)，无需宿主补丁。旧便签等会一次性迁移，未完成内容先待核实。

QQ 固定规则和框架说明统一进入锁定 system，新工作目录不再生成 `AGENTS.md` 或日记索引。升级时，确认未被修改的旧插件模板会先备份到插件数据目录的 `workspace-migrations/*.bak`，再停用原文件；手工修改或归属不明的文件保留，并记录冲突。已有会话的旧 system 与历史不会因此自动改写，仍使用原有同步选项。详见[工作目录与迁移](docs/configuration.md#工作目录指令与升级)。

rc.2 是当前已验证版本。安装允许更新的 DSH 版本；未经验证时 QQ 暂不启用，可在风险弹窗中明确确认后使用。确认只对当时的核心包版本有效；无界面部署的配置方式见接入说明。

完整默认值、角色设定、媒体处理、共享文件、作息和其他选项见 [配置参考](docs/configuration.md)。

## 本地模拟与开发

在已安装依赖的仓库目录运行：

```powershell
pnpm dev:mock
```

打开终端输出的本地网址，可模拟私聊、群聊、@ 和媒体消息，查看提示词、回复、工具结果与日志。无需启动真实 DSH、NapCat 或 QQ，也不需要模型 API key。

```powershell
pnpm test:mock   # 模拟环境场景
pnpm test:e2e    # 完整消息链路测试
pnpm test        # *.test.mjs 回归测试
```

模拟测试验证插件使用的接口和行为，不能证明真实模型效果、协议端兼容性或 QQ 账号可用性。详细说明见 [本地模拟环境](docs/mock-environment.md) 和 [测试清单](TESTING.md)。

## 常见问题

**设置页中没有 QQ**

检查插件是否加载，以及启动日志中的「客户端半端自检」结果。也可通过 `settings.json` 配置连接，排障时附上自检日志。

**连接失败或持续重连**

检查 `wsUrl`、协议端服务是否启用、端口可达性，以及两端访问令牌是否一致。确认配置的是正向 WebSocket 服务。

**收到消息但没有回复**

私聊检查 `privateMode` 和 `privateAllow`；群聊检查 `groupMode`、`groupAllow` 和 @ 触发条件。随后查看 DSH 的模型、预设及运行日志。

**重复回复**

检查是否有多个宿主实例或其他插件同时处理同一协议端的消息，见下一节。

**语音无法转写**

检查 `asrEnabled`、`asrPython`、识别依赖和 `asrModel`。语音功能的完整配置见 [配置参考](docs/configuration.md)。

## 和别的 OneBot 插件共存

同一协议端可以向多个客户端分发事件。若多个插件或宿主实例都处理同一会话，可能分别生成回复。部署时应明确每个实例负责的账号和会话范围，避免重叠处理。

需要将设置界面与消息处理进程分开部署时，可在仅提供设置页的实例启用 `uiOnly: true`。具体部署方式见 [部署文档](docs/deployment.md)。

## 使用边界

QQ 协议端由用户自行部署，可能涉及平台使用条款限制和账号风控。接入前应了解所用协议端的要求。

QQ 消息会触发宿主 Agent；允许访问的用户可能间接使用其文件、命令等工具。请根据实际用途设置访问名单、工作目录和工具权限。消息处理还可能产生模型费用，并在本地保留聊天记录与媒体缓存。

## 文档与反馈

| 文档 | 内容 |
| --- | --- |
| [配置参考](docs/configuration.md) | 配置项、默认值和行为说明 |
| [角色与会话](docs/persona.md) | 提示词、身份标记、引用和上下文管理 |
| [部署文档](docs/deployment.md) | 长期运行、多进程与启动管理 |
| [开发文档](docs/development.md) | 代码结构和开发入口 |
| [本地模拟环境](docs/mock-environment.md) | 网页模拟器、编排和故障注入 |
| [情绪系统开发进度](docs/emotion-system-development.md) | 已实现的可选消息判断、后续情绪与关系开发安排 |
| [测试清单](TESTING.md) | 自动化覆盖与真实环境验证 |
| [工具说明](tools/README.md) | 辅助脚本及使用条件 |
| [变更记录](CHANGELOG.md) | 版本变更 |

使用本 fork 遇到问题，请在 [本仓库 Issues](https://github.com/BiFangKNT/dsh-qq/issues) 提供插件版本或提交号、DSH 版本、复现步骤及相关日志，并说明安装来源。提交前请移除令牌、账号标识和私人消息等敏感内容。

部分详细文档沿用上游内容，其中的路径和部署示例需按实际环境调整。

## 许可证

[MIT](LICENSE)。保留上游版权及许可证声明。
