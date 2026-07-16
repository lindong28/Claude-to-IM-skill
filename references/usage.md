# Usage Guide

This skill works with both **Claude Code** (via `/claude-to-im` slash commands) and **Codex** (via natural language like "start bridge", "配置", "诊断"). All commands below use Claude Code syntax; Codex users can use equivalent natural language.

For any named instance, choose the identity once and keep it on every direct command. `quant-lab` is only the example value used by this plan:

```bash
INSTANCE=quant-lab
export CTI_SKILL_DIR="$HOME/.claude/skills/claude-to-im"
```

The selected name derives home `~/.claude-to-im-$INSTANCE` and label `com.claude-to-im.bridge.$INSTANCE`. Do not change or omit `INSTANCE` after setup; omission targets default.

## setup

Interactive wizard that configures the bridge.

```
/claude-to-im setup
```

The wizard will prompt you for:

1. **Channels to enable** -- Enter comma-separated values: `telegram`, `discord`, `feishu`, `qq`
2. **Platform credentials** -- Bot tokens, app IDs, and secrets for each enabled channel
3. **Allowed users** (optional) -- Restrict which users can interact with the bot
4. **Working directory** -- Default project directory for Claude Code sessions
5. **Model and mode** -- Claude model and interaction mode (code/plan/ask)

After collecting input, the wizard validates tokens by calling each platform's API and reports results.

Example interaction:

```
> /claude-to-im setup
Which channels to enable? telegram,discord
Enter Telegram bot token: <your-token>
Enter Discord bot token: <your-token>
Default working directory [/current/dir]: /Users/me/projects
Model [claude-sonnet-4-20250514]:
Mode [code]:

Validating tokens...
  Telegram: OK (bot @MyBotName)
  Discord: OK (format valid)

Config written to ~/.claude-to-im-<instance>/config.env
```

## start

Starts the bridge daemon in the background.

```bash
CTI_INSTANCE="$INSTANCE" bash "$CTI_SKILL_DIR/scripts/daemon.sh" start
```

The daemon PID and store are under that instance home. If the daemon is already running, the command reports the existing process.

If startup fails, run `CTI_INSTANCE="$INSTANCE" bash "$CTI_SKILL_DIR/scripts/doctor.sh"`.

## stop

Stops the running bridge daemon.

```bash
CTI_INSTANCE="$INSTANCE" bash "$CTI_SKILL_DIR/scripts/daemon.sh" stop
```

Stops/boots out the process while preserving its plist, config, bindings, and message/audit data.

## status

Shows whether the daemon is running and basic health information.

```bash
CTI_INSTANCE="$INSTANCE" bash "$CTI_SKILL_DIR/scripts/daemon.sh" status
```

Output includes:
- Running/stopped state
- PID (if running)
- Uptime
- Connected channels

## logs

Shows recent log output from the daemon.

```bash
CTI_INSTANCE="$INSTANCE" bash "$CTI_SKILL_DIR/scripts/daemon.sh" logs
CTI_INSTANCE="$INSTANCE" bash "$CTI_SKILL_DIR/scripts/daemon.sh" logs 200
```

Logs are stored under the instance home and are automatically redacted to mask secrets.

## uninstall and remove

```bash
CTI_INSTANCE="$INSTANCE" bash "$CTI_SKILL_DIR/scripts/daemon.sh" uninstall
CTI_INSTANCE="$INSTANCE" bash "$CTI_SKILL_DIR/scripts/daemon.sh" remove "$INSTANCE"
```

`uninstall` stops the service and removes its plist but preserves the instance home/store. `remove` requires the instance to be stopped and unregistered, requires the exact instance name as confirmation, and deletes only that named home. The default instance cannot be removed.

## reconfigure

Interactively update the current configuration.

```
/claude-to-im reconfigure
```

Displays current settings with secrets masked, then prompts for changes. After updating, you must restart the daemon for changes to take effect:

```bash
CTI_INSTANCE="$INSTANCE" bash "$CTI_SKILL_DIR/scripts/daemon.sh" stop
CTI_INSTANCE="$INSTANCE" bash "$CTI_SKILL_DIR/scripts/daemon.sh" start
```

## doctor

Runs diagnostic checks and reports issues.

```bash
CTI_INSTANCE="$INSTANCE" bash "$CTI_SKILL_DIR/scripts/doctor.sh"
```

Checks performed:
- Node.js version (>= 20 required)
- Claude Code CLI availability
- Config file exists and has correct permissions
- Required tokens are set for enabled channels
- Token validity (API calls)
- QQ credentials and gateway reachability (if QQ enabled)
- Daemon process health
- Log directory writability
- Lifecycle lock state and a guarded repair command when the owner PID is provably dead
- Current-run Feishu connection/inbound and Codex success evidence for named Feishu/Codex instances

## Fixed Feishu/Codex session recovery

With `CTI_SESSION_POLICY=fixed-confirm-recovery`, each authorized group keeps one persisted Codex thread and `/cwd`, `/new`, and `/bind` are unavailable. An explicit resume failure marks that group pending and ordinary messages make no provider call. Send `@bot /recover confirm` from the same allowed user/group; this only arms recovery. The next ordinary message creates one replacement thread and consumes the authorization.

With `CTI_CODEX_APPROVAL_POLICY=never`, Codex never emits an interactive permission request, so there is no Feishu permission card or `/perm` step.

### QQ notes

QQ currently supports **C2C private chat only**:
- No inline approval buttons — permissions use text `/perm ...` commands
- No streaming preview
- Image inbound only (no image replies)
- No group/channel support yet
- Required config: `CTI_QQ_APP_ID`, `CTI_QQ_APP_SECRET` (obtain from https://q.qq.com/qqbot/openclaw)
- `CTI_QQ_ALLOWED_USERS` takes `user_openid` values, not QQ numbers
- Set `CTI_QQ_IMAGE_ENABLED=false` if the provider doesn't support image input
