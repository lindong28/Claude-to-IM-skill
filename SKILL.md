---
name: claude-to-im
description: |
  Bridge THIS Claude Code or Codex session to Telegram, Discord, Feishu/Lark, QQ, or WeChat so the
  user can chat with Claude from their phone. Use for: setting up, starting, stopping,
  or diagnosing the claude-to-im bridge daemon; forwarding Claude replies to a messaging
  app; any phrase like "claude-to-im", "bridge", "消息推送", "消息转发", "桥接",
  "连上飞书", "手机上看claude", "启动后台服务", "诊断", "查看日志", "配置".
  Subcommands: setup, start, stop, status, logs, reconfigure, doctor, uninstall, remove.
  Do NOT use for: building standalone bots, webhook integrations, or coding with IM
  platform SDKs — those are regular programming tasks.
argument-hint: "setup | start | stop | status | logs [N] | reconfigure | doctor | uninstall | remove"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# Claude-to-IM Bridge Skill

You are managing the Claude-to-IM bridge.
The skill directory (SKILL_DIR) is at `~/.claude/skills/claude-to-im`.
In Codex installs it may instead be `~/.codex/skills/Claude-to-IM-skill`.
If neither path exists, fall back to Glob with pattern `**/skills/**/claude-to-im/SKILL.md` or `**/skills/**/Claude-to-IM-skill/SKILL.md` and derive the root from the result.

Resolve one instance identity before reading or writing config and bind it as `INSTANCE`. Use `default` unless the user names an instance; this plan uses `INSTANCE=quant-lab`. A named instance maps to home `~/.claude-to-im-$INSTANCE`, launchd label `com.claude-to-im.bridge.$INSTANCE`, and an independent config/store/log/runtime tree. Keep that variable unchanged for every setup, lifecycle, and doctor command:

```bash
CTI_INSTANCE="$INSTANCE" bash "$SKILL_DIR/scripts/daemon.sh" <start|stop|status|logs|uninstall|remove>
CTI_INSTANCE="$INSTANCE" bash "$SKILL_DIR/scripts/doctor.sh"
```

Never omit `CTI_INSTANCE` midway through a named workflow: omission targets the protected default instance.

## Command parsing

Parse the user's intent from `$ARGUMENTS` into one of these subcommands:

| User says (examples) | Subcommand |
|---|---|
| `setup`, `configure`, `配置`, `我想在飞书上用 Claude`, `帮我连接 Telegram`, `帮我接微信` | setup |
| `start`, `start bridge`, `启动`, `启动桥接` | start |
| `stop`, `stop bridge`, `停止`, `停止桥接` | stop |
| `status`, `bridge status`, `状态`, `运行状态`, `怎么看桥接的运行状态` | status |
| `logs`, `logs 200`, `查看日志`, `查看日志 200` | logs |
| `reconfigure`, `修改配置`, `帮我改一下 token`, `换个 bot` | reconfigure |
| `doctor`, `diagnose`, `诊断`, `挂了`, `没反应了`, `bot 没反应`, `出问题了` | doctor |
| `uninstall`, `卸载服务`, `取消自启` | uninstall |
| `remove`, `删除实例` | remove |

**Disambiguation: `status` vs `doctor`** — Use `status` when the user just wants to check if the bridge is running (informational). Use `doctor` when the user reports a problem or suspects something is broken (diagnostic). When in doubt and the user describes a symptom (e.g., "没反应了", "挂了"), prefer `doctor`.

Extract optional numeric argument for `logs` (default 50).

Before asking users for any platform credentials, read `SKILL_DIR/references/setup-guides.md` internally so you know where to find each credential. Do NOT dump the full guide to the user upfront — only mention the specific next step they need to do (e.g., "Go to https://open.feishu.cn → your app → Credentials to find the App ID"). If the user says they don't know how, then show the relevant section of the guide.

## Runtime detection

Before executing any subcommand, detect which environment you are running in:

1. **Claude Code** — `AskUserQuestion` tool is available. Use it for interactive setup wizards.
2. **Codex / other** — `AskUserQuestion` is NOT available. Fall back to non-interactive guidance: explain the steps, show `SKILL_DIR/config.env.example`, and ask the user to create the config in the resolved instance home manually.

You can test this by checking if AskUserQuestion is in your available tools list.

## Config check (applies to `start`, `status`, `logs`, `reconfigure`, `doctor`)

Check the resolved instance home, not hardcoded default paths. The default config is `~/.claude-to-im/config.env`; named config is `~/.claude-to-im-<instance>/config.env`.

- **If it does NOT exist:**
  - In Claude Code: tell the user "No configuration found" and automatically start the `setup` wizard using AskUserQuestion.
  - In Codex: tell the user which resolved config path is missing, show `SKILL_DIR/config.env.example`, and stop. Do not attempt start without config.
- **If it exists:** proceed with the requested subcommand.

## Subcommands

### `setup`

Run an interactive setup wizard. This subcommand requires `AskUserQuestion`. If it is not available (Codex environment), instead show the contents of `SKILL_DIR/config.env.example` with field-by-field explanations and instruct the user to create the config file manually.

When AskUserQuestion IS available, collect input **one field at a time**. After each answer, confirm the value back to the user (masking secrets to last 4 chars only) before moving to the next question.

**Step 1 — Choose channels**

Ask which channels to enable (telegram, discord, feishu, qq, weixin). Accept comma-separated input. Briefly describe each:
- **telegram** — Best for personal use. Streaming preview, inline permission buttons.
- **discord** — Good for team use. Server/channel/user-level access control.
- **feishu** (Lark) — For Feishu/Lark teams. Streaming cards, tool progress, inline permission buttons.
- **qq** — QQ C2C private chat only. No inline permission buttons, no streaming preview. Permissions use text `/perm ...` commands.
- **weixin** — WeChat QR login. Single linked account only; a new login replaces the previous one. No inline permission buttons, no streaming preview. Permissions use text `/perm ...` commands or quick `1/2/3` replies. Voice messages only use WeChat's own speech-to-text text; raw voice audio is not transcribed by the bridge.

**Step 2 — Collect tokens per channel**

For each enabled channel, collect one credential at a time. Tell the user where to find each value in one sentence. Only show the full guide section (from `SKILL_DIR/references/setup-guides.md`) if the user asks for help or says they don't know how:

- **Telegram**: Bot Token → confirm (masked) → Chat ID (see guide for how to get it) → confirm → Allowed User IDs (optional). **Important:** At least one of Chat ID or Allowed User IDs must be set, otherwise the bot will reject all messages.
- **Discord**: Bot Token → confirm (masked) → Allowed User IDs → Allowed Channel IDs (optional) → Allowed Guild IDs (optional). **Important:** At least one of Allowed User IDs or Allowed Channel IDs must be set, otherwise the bot will reject all messages (default-deny).
- **Feishu**: App ID → confirm → App Secret → confirm (masked) → Domain (optional) → Allowed User IDs → Allowed Group IDs → Require Mention. For a named group bot, require non-empty user and group allowlists, `CTI_FEISHU_GROUP_POLICY=allowlist`, and `CTI_FEISHU_REQUIRE_MENTION=true`. Explain how to verify both opaque IDs from an inbound event without pasting them into logs or chat. Then explain the two-phase setup:
  - **Phase 1** (before starting bridge): (A) batch-add permissions, (B) enable bot capability, (C) publish first version + admin approve. This makes permissions and bot effective.
  - **Phase 2** (requires running bridge): (D) start the same instance, (E) configure `im.message.receive_v1` with long connection mode, (F) publish second version + admin approve. Add `card.action.trigger` only when the selected runtime can actually produce interactive approval cards; a Codex instance with `CTI_CODEX_APPROVAL_POLICY=never` does not need it.
  - **Why two phases:** Feishu validates WebSocket connection when saving event subscription — if the bridge isn't running, saving will fail. The bridge needs published permissions to connect.
  - Keep this to a short checklist — show the full guide only if asked.
- **QQ**: Collect two required fields, then optional ones:
  1. QQ App ID (required) → confirm
  2. QQ App Secret (required) → confirm (masked)
  - Tell the user: these two values can be found at https://q.qq.com/qqbot/openclaw
  3. Allowed User OpenIDs (optional, press Enter to skip) — note: this is `user_openid`, NOT QQ number. If the user doesn't have openid yet, they can leave it empty.
  4. Image Enabled (optional, default true, press Enter to skip) — if the underlying provider doesn't support image input, set to false
  5. Max Image Size MB (optional, default 20, press Enter to skip)
  - Remind user: QQ first version only supports C2C private chat sandbox access. No group/channel support, no inline buttons, no streaming preview.
- **Weixin**: Do not ask for a static token. Instead:
  1. Tell the user this channel uses QR login, not manual credential entry.
  2. Run `cd SKILL_DIR && npm run weixin:login`
  3. The helper writes `~/.claude-to-im/runtime/weixin-login.html` and tries to open it automatically in the local browser.
  4. If auto-open fails, tell the user to open that HTML file manually and scan the QR code with WeChat.
  5. Wait for the helper to report success, then confirm that the linked account was saved locally.
  - Explain briefly: the linked Weixin account is stored in `~/.claude-to-im/data/weixin-accounts.json`. Running the helper again replaces the previously linked account.
  - Explain briefly: `CTI_WEIXIN_MEDIA_ENABLED` only controls inbound image/file/video downloads. For voice messages, the bridge only accepts the text returned by WeChat's built-in speech-to-text. If WeChat does not provide a transcript, the bridge replies with an error instead of downloading/transcribing raw audio.

**Step 3 — General settings**

Ask for runtime, default working directory, model, and mode:
- **Runtime**: `claude` (default), `codex`, `auto`
  - `claude` — uses Claude Code CLI + Claude Agent SDK (requires `claude` CLI installed)
  - `codex` — uses OpenAI Codex SDK (requires `codex` CLI; auth via `codex login` or `OPENAI_API_KEY`)
  - `auto` — tries Claude first, falls back to Codex if Claude CLI not found
- **Working Directory**: default `$CWD`
- **Model** (optional): Leave blank to inherit the runtime's own default model. If the user wants to override, ask them to enter a model name. Do NOT hardcode or suggest specific model names — the available models change over time.
- **Mode**: `code` (default), `plan`, `ask`

**Step 4 — Write config and validate**

1. Show a final summary table with all settings (secrets masked to last 4 chars)
2. Ask user to confirm before writing
3. Create the resolved instance home and `{data,logs,runtime,data/messages}` directories with mode `0700`
4. Write `config.env` in that home, never in a different instance's home
5. Set `config.env` mode to `0600`
6. Validate tokens — read `SKILL_DIR/references/token-validation.md` for the exact commands and expected responses for each platform. This catches typos and wrong credentials before the user tries to start the daemon. For Weixin, a successful QR login already counts as validation.
7. Report results with a summary table. If any validation fails, explain what might be wrong and how to fix it.
8. On success, show the exact same-instance start and doctor commands

For a named Feishu/Codex fixed instance, write these explicit policy keys and leave `CTI_DEFAULT_MODEL` unset:

```dotenv
CTI_SESSION_POLICY=fixed-confirm-recovery
CTI_CODEX_SANDBOX_MODE=workspace-write
CTI_CODEX_APPROVAL_POLICY=never
CTI_CODEX_NETWORK_ACCESS=true
```

### `start`

Run the resolved identity: `CTI_INSTANCE="$INSTANCE" bash "$SKILL_DIR/scripts/daemon.sh" start`.

Show the output to the user. If it fails, tell the user:
- Run same-instance doctor: `CTI_INSTANCE="$INSTANCE" bash "$SKILL_DIR/scripts/doctor.sh"`
- Check same-instance logs: `CTI_INSTANCE="$INSTANCE" bash "$SKILL_DIR/scripts/daemon.sh" logs`

### `stop`

Run: `CTI_INSTANCE="$INSTANCE" bash "$SKILL_DIR/scripts/daemon.sh" stop`. This stops/boots out the process but preserves its plist and home for a later start.

### `status`

Run: `CTI_INSTANCE="$INSTANCE" bash "$SKILL_DIR/scripts/daemon.sh" status`.

### `logs`

Extract optional line count N from arguments (default 50).
Run: `CTI_INSTANCE="$INSTANCE" bash "$SKILL_DIR/scripts/daemon.sh" logs N`.

### `reconfigure`

1. Read current config from the resolved instance home
2. Show current settings in a clear table format, with all secrets masked (only last 4 chars visible)
3. Use AskUserQuestion to ask what the user wants to change
4. When collecting new values, tell the user where to find the value; only show the full guide from `SKILL_DIR/references/setup-guides.md` if they ask for help
5. Update the config file atomically (write to tmp, rename)
6. Re-validate any changed tokens
7. Remind the user to stop/start the same instance to apply changes

If the user wants to switch Weixin accounts during `reconfigure`, run `cd SKILL_DIR && npm run weixin:login` again. Each successful scan replaces the previously linked local account.

### `doctor`

Run: `CTI_INSTANCE="$INSTANCE" bash "$SKILL_DIR/scripts/doctor.sh"` for the same named instance.

Show results and suggest fixes for any failures. Common fixes:
- SDK cli.js missing → `cd SKILL_DIR && npm install`
- dist/daemon.mjs stale → `cd SKILL_DIR && npm run build`
- Config missing → run `setup`
- Weixin account missing / expired → `cd SKILL_DIR && npm run weixin:login`
- Weixin voice message reports missing speech-to-text → enable WeChat's own voice transcription and resend; the bridge does not transcribe raw voice audio itself

For more complex issues (messages not received, permission timeouts, high memory, stale PID files), read `SKILL_DIR/references/troubleshooting.md` for detailed diagnosis steps.

### `uninstall` and `remove`

- `CTI_INSTANCE="$INSTANCE" bash "$SKILL_DIR/scripts/daemon.sh" uninstall` stops/unregisters the LaunchAgent but preserves the entire instance home and store.
- `CTI_INSTANCE="$INSTANCE" bash "$SKILL_DIR/scripts/daemon.sh" remove "$INSTANCE"` deletes that home only after it is stopped and unregistered. The confirmation must exactly match the instance. `remove` refuses `default`.

**Feishu upgrade note:** Read `references/setup-guides.md` before changing scopes/callbacks, then restart and diagnose with the already-bound `INSTANCE`. Keep two publish phases. Do not add `card.action.trigger` to a Codex/never instance merely because generic interactive runtimes use it.

## Notes

- Always mask secrets in output (show only last 4 characters) — users often share terminal output in bug reports, so exposed tokens would be a security incident.
- Always check for config.env before starting the daemon.
- The daemon runs as a background Node.js process managed by platform supervisor (launchd on macOS, setsid on Linux, WinSW/NSSM on Windows).
- Config and store persist under the resolved instance home across sessions and ordinary stop/uninstall operations.
