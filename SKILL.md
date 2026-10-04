---
name: claude-to-im
description: |
  Bridge THIS Claude Code or Codex session to Telegram, Discord, Feishu/Lark, QQ, or WeChat so the
  user can chat with Claude from their phone. Use for: setting up, starting, stopping,
  or diagnosing the claude-to-im bridge daemon; forwarding Claude replies to a messaging
  app through this bridge, including requests like "连上飞书" or "手机上看claude".
  Generic configuration, logs, diagnosis, or background-service requests only match
  when they refer to this bridge.
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
Set `SKILL_DIR` to the real directory containing this file. A workflow router may load this guide from a runtime component outside the skill discovery directories; use that resolved location for scripts and resources. Standalone installations may still place it under `~/.claude/skills/claude-to-im` or `~/.codex/skills/Claude-to-IM-skill`.

Resolve one instance identity before accessing its config or state and bind it as `INSTANCE`. Use `default` unless the user names an instance. Resolve its home through `scripts/instance-env.sh`, preserving an explicit `CTI_HOME` only when it belongs to the selected instance. The resolver derives the default or named home and checks ownership and unsafe aliases. Bind its result as `INSTANCE_HOME`; stop if resolution fails. Keep both values for setup, lifecycle, diagnosis, and login:

```bash
INSTANCE_HOME="$(CTI_INSTANCE="$INSTANCE" bash -c 'source "$1" || exit $?; printf "%s\n" "$CTI_HOME"' _ "$SKILL_DIR/scripts/instance-env.sh")" || exit
CTI_INSTANCE="$INSTANCE" CTI_HOME="$INSTANCE_HOME" bash "$SKILL_DIR/scripts/daemon.sh" <start|stop|status|logs|uninstall|remove>
CTI_INSTANCE="$INSTANCE" CTI_HOME="$INSTANCE_HOME" bash "$SKILL_DIR/scripts/doctor.sh"
```

Do not omit either identity value midway through a workflow. Direct Node helpers need `CTI_HOME`; `CTI_INSTANCE` alone does not select their store.

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

## AskUserQuestion capability detection

Only when missing input or a user-owned choice requires a question, select a presentation mode through this ordered check. Reuse an already resolved, still available capability:

1. If `AskUserQuestion` is directly callable and renders an elicitation form, use **interactive form**.
2. Otherwise, in Codex use the current surface's deferred discovery mechanism to find the exact canonical name `mcp__ask_user__AskUserQuestion`. If the discovered tool renders an elicitation form, use **interactive form**.
3. If discovery is unavailable, the exact lookup is empty, the call fails, or the tool returns a fallback instruction, use **chat fallback**: present numbered options in the response, stop for the user's answer, and do not choose for the user.

## Configuration source and missing config

Check `$INSTANCE_HOME/config.env` without exposing its values. Before setup or reconfiguration, identify who owns that configuration:

- **Repository-managed deployment:** follow the owning repository's rules, edit its tracked source, and apply it through its installer. `scripts/install-from-repo.sh` consumes `skill-configs/claude-to-im/instances/<instance>/config.env` in its owning harness repository. It can materialize or restart multiple instances; check its actual effects against the request before running it. Do not hand-edit a generated runtime copy or treat a single-instance request as permission to change other instances.
- **Standalone installation:** write the resolved home config. Preserve private directory mode `0700` and config mode `0600`.

For `status`, `logs`, and `doctor`, complete the requested check and report missing configuration; do not turn a query into setup. `doctor` also checks configured tokens against platform APIs. For `start` or `reconfigure` without config, report the missing path and continue setup only if configuration is already authorized; otherwise ask whether to set it up. Never start an unconfigured instance.

## Subcommands

### `setup`

Reuse values the user already supplied. Ask only for missing or ambiguous inputs, grouping independent fields within the question tool's limits; wait for dependent answers before asking their follow-ups. Do not repeat each value for a separate confirmation. Keep the final confirmation before writing configuration. With chat fallback, group the current missing inputs, number actual choices, and wait for the user's answer rather than choosing for them. Follow the deployment's approved credential-entry mechanism; never echo raw credentials or opaque account IDs into chat or logs.

**Step 1 — Choose channels**

If not already specified, ask which channels to enable (telegram, discord, feishu, qq, weixin). Accept comma-separated input. Describe relevant choices briefly:
- **telegram** — Best for personal use. Streaming preview, inline permission buttons.
- **discord** — Good for team use. Server/channel/user-level access control.
- **feishu** (Lark) — For Feishu/Lark teams. Streaming cards, tool progress, inline permission buttons.
- **qq** — QQ C2C private chat only. No inline permission buttons, no streaming preview. Permissions use text `/perm ...` commands.
- **weixin** — WeChat QR login. Single linked account only; a new login replaces the previous one. No inline permission buttons, no streaming preview. Permissions use text `/perm ...` commands or quick `1/2/3` replies. Voice messages only use WeChat's own speech-to-text text; raw voice audio is not transcribed by the bridge.

**Step 2 — Collect tokens per channel**

For the enabled channels, collect missing credentials and access settings. Explain where to find each missing value briefly; show the relevant `SKILL_DIR/references/setup-guides.md` section when help is needed:

- **Telegram**: Bot Token, Chat ID (see guide), Allowed User IDs (optional). **Important:** At least one of Chat ID or Allowed User IDs must be set, otherwise the bot will reject all messages.
- **Discord**: Bot Token, Allowed User IDs, Allowed Channel IDs (optional), Allowed Guild IDs (optional). **Important:** At least one of Allowed User IDs or Allowed Channel IDs must be set, otherwise the bot will reject all messages (default-deny).
- **Feishu**: App ID, App Secret, Domain (optional), Allowed User IDs, Allowed Group IDs, Require Mention. For a named group bot, require non-empty user and group allowlists, `CTI_FEISHU_GROUP_POLICY=allowlist`, and `CTI_FEISHU_REQUIRE_MENTION=true`. Explain how to verify both opaque IDs from an inbound event without pasting them into logs or chat. Then explain the two-phase setup:
  - **Phase 1** (before starting bridge): (A) batch-add permissions, (B) enable bot capability, (C) publish first version + admin approve. This makes permissions and bot effective.
  - **Phase 2** (requires running bridge): (D) start the same instance, (E) configure `im.message.receive_v1` with long connection mode, (F) publish second version + admin approve. Add `card.action.trigger` only when the selected runtime can actually produce interactive approval cards; a Codex instance with `CTI_CODEX_APPROVAL_POLICY=never` does not need it.
  - **Why two phases:** Feishu validates WebSocket connection when saving event subscription — if the bridge isn't running, saving will fail. The bridge needs published permissions to connect.
  - Keep this to a short checklist — show the full guide only if asked.
- **QQ**: Collect two required fields, then optional ones:
  1. QQ App ID (required)
  2. QQ App Secret (required)
  - Tell the user: these two values can be found at https://q.qq.com/qqbot/openclaw
  3. Allowed User OpenIDs (optional, press Enter to skip) — note: this is `user_openid`, NOT QQ number. If the user doesn't have openid yet, they can leave it empty.
  4. Image Enabled (optional, default true, press Enter to skip) — if the underlying provider doesn't support image input, set to false
  5. Max Image Size MB (optional, default 20, press Enter to skip)
  - Remind user: QQ first version only supports C2C private chat sandbox access. No group/channel support, no inline buttons, no streaming preview.
- **Weixin**: Do not ask for a static token. Instead:
  1. Tell the user this channel uses QR login, not manual credential entry.
  2. For the resolved instance, run `(cd "$SKILL_DIR" && CTI_INSTANCE="$INSTANCE" CTI_HOME="$INSTANCE_HOME" npm run weixin:login)`.
  3. The helper writes `$INSTANCE_HOME/runtime/weixin-login.html` and tries to open it automatically in the local browser; tell the user before launching it. Follow the active harness's frontend-consent and local-delivery rules if browser access needs assistance.
  4. Have the user scan the QR code with WeChat. Only replace an existing linked account when that change is covered by the user's request or confirmation.
  5. Wait for the helper to report success, then confirm that the linked account was saved locally.
  - Explain briefly: the linked Weixin account is stored in `$INSTANCE_HOME/data/weixin-accounts.json`. Running the helper again replaces that instance's previously linked account.
  - Explain briefly: `CTI_WEIXIN_MEDIA_ENABLED` only controls inbound image/file/video downloads. For voice messages, the bridge only accepts the text returned by WeChat's built-in speech-to-text. If WeChat does not provide a transcript, the bridge replies with an error instead of downloading/transcribing raw audio.

**Step 3 — General settings**

Collect any missing runtime, default working directory, model, and mode choices:
- **Runtime**: `claude` (default), `codex`, `auto`
  - `claude` — uses Claude Code CLI + Claude Agent SDK (requires `claude` CLI installed)
  - `codex` — uses OpenAI Codex SDK (requires `codex` CLI; auth via `codex login` or `OPENAI_API_KEY`)
  - `auto` — tries Claude first, falls back to Codex if Claude CLI not found
- **Working Directory**: default `$CWD`
- **Model** (optional): Leave blank to inherit the runtime's own default model. If the user wants to override, ask them to enter a model name. Do NOT hardcode or suggest specific model names — the available models change over time.
- **Mode**: `code` (default), `plan`, `ask`

**Step 4 — Write config and validate**

1. Summarize the selected instance, configuration source, and settings without exposing credentials or opaque IDs.
2. Ask the user to confirm before writing, reusing an existing confirmation only if it covers this exact configuration.
3. Save configuration at its owning source with mode `0600`, without applying or restarting it yet. For standalone installs, create the resolved home and `{data,logs,runtime,data/messages}` directories with mode `0700` and write `config.env` atomically. For repository-managed installs, edit the tracked source; defer the installer until validation succeeds.
4. Validate the candidate credentials from that saved source, not the old runtime copy. Read `SKILL_DIR/references/token-validation.md` for the platform checks and keep sensitive responses out of tool output. For Weixin, a successful same-instance QR login counts as validation. If validation fails, report it and leave the running service alone.
5. After successful validation, apply only deployment or restart actions covered by the request. This includes any installer that can start or restart services. Preserve private directory/config modes through the owning installer.
6. Report validation, saved source, and running configuration separately; when application is pending, do not report the new configuration as active.
7. On success, continue any already authorized start step; otherwise report readiness and the same-instance start and doctor commands.

For a named Feishu/Codex fixed instance, write these explicit policy keys and leave `CTI_DEFAULT_MODEL` unset:

```dotenv
CTI_SESSION_POLICY=fixed-confirm-recovery
CTI_CODEX_SANDBOX_MODE=workspace-write
CTI_CODEX_APPROVAL_POLICY=never
CTI_CODEX_NETWORK_ACCESS=true
```

### `start`

Run the resolved identity: `CTI_INSTANCE="$INSTANCE" CTI_HOME="$INSTANCE_HOME" bash "$SKILL_DIR/scripts/daemon.sh" start`.

Report the result without exposing credentials. If it fails, inspect same-instance logs and follow the failure evidence within the authorized scope; use doctor when its diagnostic checks are needed. Do not delegate these available checks back to the user.

### `stop`

Run: `CTI_INSTANCE="$INSTANCE" CTI_HOME="$INSTANCE_HOME" bash "$SKILL_DIR/scripts/daemon.sh" stop`. This stops/boots out the process but preserves its plist and home for a later start.

### `status`

Run: `CTI_INSTANCE="$INSTANCE" CTI_HOME="$INSTANCE_HOME" bash "$SKILL_DIR/scripts/daemon.sh" status`.

### `logs`

Extract optional line count N from arguments (default 50).
Run: `CTI_INSTANCE="$INSTANCE" CTI_HOME="$INSTANCE_HOME" bash "$SKILL_DIR/scripts/daemon.sh" logs N`.

### `reconfigure`

Read the current configuration from its owning source without exposing sensitive values. Use the requested changes directly; ask only for missing or ambiguous values as in setup. Confirm the resulting configuration before writing, then use setup Step 4's source, private-write, and application rules. Re-validate changed tokens only. Apply an already authorized same-instance restart; otherwise report that the saved change is not yet applied.

For a requested Weixin account switch, use the same-instance login command and replacement boundary from setup Step 2.

### `doctor`

Run: `CTI_INSTANCE="$INSTANCE" CTI_HOME="$INSTANCE_HOME" bash "$SKILL_DIR/scripts/doctor.sh"` for the same instance.

Show results and suggest fixes for any failures. Common fixes:
- SDK cli.js missing → `cd SKILL_DIR && npm install`
- dist/daemon.mjs stale → `cd SKILL_DIR && npm run build`
- Config missing → run `setup`
- Weixin account missing / expired → same-instance login from setup Step 2, when authorized
- Weixin voice message reports missing speech-to-text → enable WeChat's own voice transcription and resend; the bridge does not transcribe raw voice audio itself

For more complex issues (messages not received, permission timeouts, high memory, stale PID files), read `SKILL_DIR/references/troubleshooting.md` for detailed diagnosis steps.

### `uninstall` and `remove`

- `CTI_INSTANCE="$INSTANCE" CTI_HOME="$INSTANCE_HOME" bash "$SKILL_DIR/scripts/daemon.sh" uninstall` stops/unregisters the LaunchAgent but preserves the entire instance home and store.
- `CTI_INSTANCE="$INSTANCE" CTI_HOME="$INSTANCE_HOME" bash "$SKILL_DIR/scripts/daemon.sh" remove "$INSTANCE"` deletes that home only after it is stopped and unregistered. The confirmation must exactly match the instance. `remove` refuses `default`.

**Feishu upgrade note:** Read `references/setup-guides.md` before changing scopes/callbacks, then restart and diagnose with the already-bound `INSTANCE`. Keep two publish phases. Do not add `card.action.trigger` to a Codex/never instance merely because generic interactive runtimes use it.

## Notes

- Always mask secrets in output (show only last 4 characters) — users often share terminal output in bug reports, so exposed tokens would be a security incident.
- Always check for config.env before starting the daemon.
- The daemon runs as a background Node.js process managed by platform supervisor (launchd on macOS, setsid on Linux, WinSW/NSSM on Windows).
- Config and store persist under the resolved instance home across sessions and ordinary stop/uninstall operations.
