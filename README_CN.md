# Claude-to-IM Skill

将 Claude Code / Codex 桥接到 IM 平台 —— 在 Telegram、Discord、飞书、QQ 或微信中与 AI 编程代理对话。

[English](README.md)

在 `ai-agent-config` 中，本仓作为顶层 `claude-to-im/` 运行组件安装，使用 `communication-workflows manage-chat-bridge <动作>` 进入；`SKILL.md` 是按需操作指引，不再作为第二个 skill 被发现。父仓安装器调用 `scripts/install-from-repo.sh`，本地 core 依赖位于 `../library/Claude-to-IM`。在父仓运行 `CTI_INSTANCE=<实例> bash claude-to-im/scripts/daemon.sh status` 检查状态。实例 home 与配置来源保留。下文独立 skill 安装说明描述的是另一种布局。

> **想要桌面图形界面？** 试试 [CodePilot](https://github.com/op7418/CodePilot) —— 一个功能完整的桌面应用，提供可视化聊天界面、会话管理、文件树预览、权限控制等。本 Skill 从 CodePilot 的 IM 桥接模块中提取而来，适合偏好轻量级纯 CLI 方案的用户。

---

## 工作原理

本 Skill 运行一个后台守护进程，将你的 IM 机器人连接到 Claude Code 或 Codex 会话。来自 IM 的消息被转发给 AI 编程代理，响应（包括工具调用、权限请求、流式预览）会发回到聊天中。

```
你 (Telegram/Discord/飞书/QQ/微信)
  ↕ Bot API
后台守护进程 (Node.js)
  ↕ Claude Agent SDK 或 Codex SDK（通过 CTI_RUNTIME 配置）
Claude Code / Codex → 读写你的代码库
```

## 功能特点

- **五大 IM 平台** — Telegram、Discord、飞书、QQ、微信，可任意组合启用
- **交互式配置** — 引导式向导逐步收集 token，附带详细获取说明
- **权限控制** — 交互式 runtime 使用内联按钮或 `/perm`；Codex approval `never` 由 sandbox 约束，不产生审批提示
- **流式预览** — 实时查看 Claude 的输出（Telegram 和 Discord 支持）
- **会话持久化** — 对话在守护进程重启后保留
- **密钥保护** — token 以 `chmod 600` 存储，日志中自动脱敏
- **无需编写代码** — 安装 Skill 后运行 `/claude-to-im setup`，或直接对 Codex 说 `claude-to-im setup`

## 前置要求

- **Node.js >= 20**
- **Claude Code CLI**（`CTI_RUNTIME=claude` 或 `auto` 时需要）— 已安装并完成认证（`claude` 命令可用）
- **Codex CLI**（`CTI_RUNTIME=codex` 或 `auto` 时需要）— `npm install -g @openai/codex`。鉴权：运行 `codex login`，或设置 `OPENAI_API_KEY`（可选，API 模式）

## 安装

请先按你实际使用的 AI Agent 产品选择对应安装方式。

### Claude Code

#### 推荐：`npx skills`

```bash
npx skills add op7418/Claude-to-IM-skill
```

安装完成后，直接对 Claude Code 说：

```text
/claude-to-im setup
```

如果你主要想接微信，也可以直接说：

```text
帮我接微信
```

#### 备选：直接克隆到 Claude Code Skills 目录

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/.claude/skills/claude-to-im
```

Claude Code 会自动发现。

#### 备选：符号链接方式（适合开发）

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/code/Claude-to-IM-skill
mkdir -p ~/.claude/skills
ln -s ~/code/Claude-to-IM-skill ~/.claude/skills/claude-to-im
```

### Codex

#### 推荐：使用 Codex 安装脚本

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/code/Claude-to-IM-skill
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh
```

如果你想保留可开发的本地仓库：

```bash
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh --link
```

安装脚本会把 Skill 放到 `~/.codex/skills/claude-to-im`，并自动安装依赖、构建 daemon。

安装完成后，直接对 Codex 说：

```text
claude-to-im setup
```

如果你主要想接微信，也可以直接说：

```text
帮我接微信桥接
```

#### 备选：直接克隆到 Codex skills 目录

```bash
git clone https://github.com/op7418/Claude-to-IM-skill.git ~/.codex/skills/claude-to-im
cd ~/.codex/skills/claude-to-im
npm install
npm run build
```

### 验证安装

**Claude Code：** 启动新会话，输入 `/` 应能看到 `claude-to-im`。也可以直接问 Claude："What skills are available?"

**Codex：** 启动新会话，说 `claude-to-im setup`、`start bridge` 或 `帮我接微信桥接`。

## 更新 Skill

请按你的 AI Agent 产品和安装方式选择对应的更新方式。

### Claude Code

如果你是通过 `npx skills` 安装的，直接重新执行：

```bash
npx skills add op7418/Claude-to-IM-skill
```

如果你是通过 `git clone` 或符号链接安装的：

```bash
cd ~/.claude/skills/claude-to-im
git pull
npm install
npm run build
```

更新完成后，对 Claude Code 说：

```text
/claude-to-im doctor
/claude-to-im start
```

### Codex

如果你是用 `install-codex.sh` 的复制模式安装的：

```bash
rm -rf ~/.codex/skills/claude-to-im
bash ~/code/Claude-to-IM-skill/scripts/install-codex.sh
```

如果你是用 `--link` 模式，或者直接克隆到 Codex skills 目录：

```bash
cd ~/.codex/skills/claude-to-im
git pull
npm install
npm run build
```

更新完成后，对 Codex 说：

```text
claude-to-im doctor
start bridge
```

## 快速开始

### 1. 配置

**Claude Code**

```text
/claude-to-im setup
```

**Codex**

```text
claude-to-im setup
```

向导会引导你完成以下步骤：

1. **选择渠道** — 选择 Telegram、Discord、飞书、QQ、微信，或任意组合
2. **输入凭据** — 向导会详细说明如何获取每个 token、需要开启哪些设置、授予哪些权限
3. **设置默认值** — 工作目录、模型、模式
4. **验证** — 立即通过平台 API 验证 token 有效性

配置时复用已提供的信息，合并询问互不依赖的缺项，写入前统一确认。查询状态、日志或诊断时，缺配置不会自动进入配置向导。仓库管理的配置修改 tracked source 并由部署 owner 应用；独立安装才直接写入选定实例的私有配置。登录和生命周期命令使用同一份实例名与解析后的目录。

### 2. 启动

**Claude Code**

```text
/claude-to-im start
```

**Codex**

```text
start bridge
```

守护进程在后台启动。关闭终端后仍会继续运行。

### Named instance

配置、生命周期和诊断必须使用同一实例身份。例如：

```bash
INSTANCE=quant-lab # 本方案示例；只选择一次。
CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh start
CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh status
CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/doctor.sh
```

`quant-lab` 会推导出 home `~/.claude-to-im-quant-lab` 和 launchd label `com.claude-to-im.bridge.quant-lab`；config、会话绑定、日志、PID、健康状态和审计证据均与 default（`~/.claude-to-im`、`com.claude-to-im.bridge`）隔离。省略 `CTI_INSTANCE` 就会指向 default。

### 3. 开始聊天

打开 IM 应用，给你的机器人发消息，Claude Code / Codex 会通过桥接回复。

交互式 runtime 可能发送权限按钮或 `/perm` 提示。配置 `CTI_CODEX_APPROVAL_POLICY=never` 的 Codex 实例不会请求权限，也不会发送飞书 permission card；工具能力由 sandbox policy 约束。

## 命令列表

所有命令在 Claude Code 或 Codex 中执行：

| Claude Code | Codex（自然语言） | 说明 |
|---|---|---|
| `/claude-to-im setup` | "claude-to-im setup" / "配置" | 交互式配置向导 |
| `/claude-to-im start` | "start bridge" / "启动桥接" | 启动桥接守护进程 |
| `/claude-to-im stop` | "stop bridge" / "停止桥接" | 停止守护进程 |
| `/claude-to-im status` | "bridge status" / "状态" | 查看运行状态 |
| `/claude-to-im logs` | "查看日志" | 查看最近 50 行日志 |
| `/claude-to-im logs 200` | "logs 200" | 查看最近 200 行日志 |
| `/claude-to-im reconfigure` | "reconfigure" / "修改配置" | 交互式修改配置 |
| `/claude-to-im doctor` | "doctor" / "诊断" | 诊断问题 |

Named instance 直接使用同一身份运行：

```bash
CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh start
CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh stop
CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh status
CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh logs 200
CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh uninstall
CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh remove "$INSTANCE"
CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/doctor.sh
```

`stop` 停止/bootout 进程，但保留 plist 和 home；`uninstall` 还会删除 plist，但保留 home/store；`remove` 要求实例已停止、已注销且确认参数与实例名完全一致，只删除该 named home，并拒绝删除 `default`。

## 平台配置指南

`setup` 向导会在每一步提供内联指引，以下是概要：

### Telegram

1. 在 Telegram 中搜索 `@BotFather` → 发送 `/newbot` → 按提示操作
2. 复制 bot token（格式：`123456789:AABbCc...`）
3. 建议：`/setprivacy` → Disable（用于群组）
4. 获取 User ID：给 `@userinfobot` 发消息

### Discord

1. 前往 [Discord 开发者门户](https://discord.com/developers/applications) → 新建应用
2. Bot 标签页 → Reset Token → 复制 token
3. 在 Privileged Gateway Intents 下开启 **Message Content Intent**
4. OAuth2 → URL Generator → scope 选 `bot` → 权限选 Send Messages、Read Message History、View Channels → 复制邀请链接

### 飞书 / Lark

1. 前往[飞书开放平台](https://open.feishu.cn/app)（或 [Lark](https://open.larksuite.com/app)）
2. 创建自建应用 → 获取 App ID 和 App Secret
3. **批量添加权限**：进入"权限管理" → 使用批量配置添加所有必需权限（`setup` 向导提供完整 JSON）
4. 在"添加应用能力"中启用机器人
5. 同时配置 `CTI_FEISHU_ALLOWED_USERS` 与 `CTI_FEISHU_GROUP_ALLOW_FROM`，group policy 使用 `allowlist`，并要求 @mention；从受控入站事件元数据核对 opaque user/group ID，不把 ID 写入日志
6. Phase 1 发布后，启动同一实例，再选择**长连接**并添加 `im.message.receive_v1`
7. 只有 runtime 会产生交互审批卡时才添加 `card.action.trigger`；Codex approval `never` 不需要它
8. 发布 Phase 2 并完成管理员审批

### QQ

> QQ 目前仅支持 **C2C 私聊**（沙箱接入）。不支持群聊/频道、内联权限按钮、流式预览。权限确认使用文本 `/perm ...` 命令。仅支持图片入站（不支持图片回复）。

1. 前往 [QQ 机器人 OpenClaw](https://q.qq.com/qqbot/openclaw)
2. 创建或选择已有 QQ 机器人 → 获取 **App ID** 和 **App Secret**（仅需这两个必填项）
3. 配置沙箱接入，用 QQ 扫码添加机器人
4. `CTI_QQ_ALLOWED_USERS` 填写 `user_openid`（不是 QQ 号）— 可先留空
5. 如果底层 provider 不支持图片输入，设置 `CTI_QQ_IMAGE_ENABLED=false`

### 微信 / Weixin

> 微信当前采用扫码登录、单账号模式、文本权限确认，不支持流式预览。

1. 在已安装的 Skill 目录里运行本地扫码工具：
   - Claude Code 默认安装：`cd ~/.claude/skills/claude-to-im && npm run weixin:login`
   - Codex 默认安装：`cd ~/.codex/skills/claude-to-im && npm run weixin:login`
2. 工具会生成 `~/.claude-to-im/runtime/weixin-login.html`，并尽量自动用浏览器打开
3. 用微信扫码并在手机上确认
4. 成功后，账号会保存到 `~/.claude-to-im/data/weixin-accounts.json`
5. 再次运行扫码工具，会替换当前已绑定的微信账号

补充说明：

- `CTI_WEIXIN_MEDIA_ENABLED` 只控制图片 / 文件 / 视频的入站下载
- 语音消息只使用微信自带的语音转文字结果
- 如果微信没有提供 `voice_item.text`，桥会直接报错，不会自行下载或转写原始语音
- 权限确认使用文本 `/perm ...` 命令或快捷 `1/2/3` 回复

## 架构

```

Named instance 使用 `~/.claude-to-im-<instance>/` 下的同一结构。固定会话策略会给每个获准飞书群持久绑定一个 Codex thread。明确的 resume 失败后，普通消息 fail closed；在同一获准群发送 `@bot /recover confirm` 只会 arm recovery，下一条普通消息才会创建并持久化一次替代 thread，confirm 本身不调用 Codex。
~/.claude-to-im/
├── config.env             ← 凭据与配置 (chmod 600)
├── data/                  ← 持久化 JSON 存储
│   ├── sessions.json
│   ├── bindings.json
│   ├── permissions.json
│   └── messages/          ← 按会话分文件的消息历史
├── logs/
│   └── bridge.log         ← 自动轮转，密钥脱敏
└── runtime/
    ├── bridge.pid          ← 守护进程 PID 文件
    └── status.json         ← 当前状态
```

### 核心组件

| 组件 | 职责 |
|---|---|
| `src/main.ts` | 守护进程入口，组装依赖注入，启动 bridge |
| `src/config.ts` | 加载/保存 `config.env`，映射为 bridge 设置 |
| `src/store.ts` | JSON 文件 BridgeStore（30 个方法，写穿缓存） |
| `src/llm-provider.ts` | Claude Agent SDK `query()` → SSE 流 |
| `src/codex-provider.ts` | Codex SDK `runStreamed()` → SSE 流 |
| `src/sse-utils.ts` | 共享的 SSE 格式化辅助函数 |
| `src/permission-gateway.ts` | 异步桥接：SDK `canUseTool` ↔ IM 按钮 |
| `src/logger.ts` | 密钥脱敏的文件日志，支持轮转 |
| `scripts/daemon.sh` | 进程管理（start/stop/status/logs） |
| `scripts/doctor.sh` | 诊断检查 |
| `SKILL.md` | Claude Code Skill 定义文件 |

### 交互式权限流程

此流程只适用于所选 runtime 会请求审批的情况；Codex approval `never` 没有该流程。

```
1. Claude 想使用工具（如编辑文件）
2. SDK 调用 canUseTool() → LLMProvider 发射 permission_request SSE 事件
3. Bridge 在 IM 聊天中发送内联按钮：[允许] [拒绝]
4. canUseTool() 阻塞等待用户响应（5 分钟超时）
5. 用户点击允许 → Bridge 解除权限等待
6. SDK 继续执行工具 → 结果流式发回 IM
```

## 故障排查

运行诊断：

```
/claude-to-im doctor
```

检查项目：Node.js 版本、配置文件是否存在及权限、token 有效性（实时 API 调用）、日志目录、PID 文件一致性、最近的错误。

| 问题 | 解决方案 |
|---|---|
| `Bridge 无法启动` | 运行 `doctor`，检查 Node 版本和日志 |
| `收不到消息` | 用 `doctor` 验证 token，检查允许用户配置 |
| `权限超时` | 用户 5 分钟内未响应，工具调用自动拒绝 |
| `PID 文件残留` | 运行 `stop` 再 `start`，脚本会自动清理 |

Lifecycle lock 与 PID 文件不同。若进程崩溃或断电后 `doctor` 报告已验证的 stale lifecycle lock，只执行它打印的同实例修复命令。修复会拒绝 live、结构异常、owner 不匹配、symlink 或含额外文件的 lock。

固定 Codex 实例会在实例 runtime 目录写入私有 call-envelope/rollout association 证据。目前没有自动 retention/pruning；应在实例停止时按本地策略归档或删除。证据缺失或歧义属于 `audit-unavailable`，不能证明重跑条件相同。关联对 append 歧义、文件替换/轮转和缩短 fail closed；同 inode 原地 truncate 后重新增长超过 checkpoint size 是已知残余边界，不得把这种证据视为可信。

详见 [references/troubleshooting.md](references/troubleshooting.md)。

## 安全

- 所有凭据存储在 `~/.claude-to-im/config.env`，权限 `chmod 600`
- 日志输出中 token 自动脱敏（基于正则匹配）
- 允许用户/频道/服务器列表限制谁可以与机器人交互
- 守护进程是本地进程，没有入站网络监听
- 详见 [SECURITY.md](SECURITY.md) 了解威胁模型和应急响应

## 开发

```bash
npm install        # 安装依赖
npm run dev        # 开发模式运行
npm run typecheck  # 类型检查
npm test           # 运行测试
npm run build      # 构建打包
```

## 许可

[MIT](LICENSE)
