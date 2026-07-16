# Troubleshooting

Bind the target name once as `INSTANCE` and keep `CTI_INSTANCE="$INSTANCE"` on every command below. `quant-lab` is only an example instance name.

## Bridge won't start

**Symptoms**: `CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh start` fails or the daemon exits immediately.

**Steps**:

1. Run same-instance doctor: `CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/doctor.sh`
2. Check that Node.js >= 20 is installed: `node --version`
3. Check that Claude Code CLI is available: `claude --version`
4. Verify config exists at the resolved named home: `~/.claude-to-im-$INSTANCE/config.env`
5. Check same-instance logs: `CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh logs`

**Common causes**:
- Missing or invalid config.env -- run `/claude-to-im setup`
- Node.js not found or wrong version -- install Node.js >= 20
- Lifecycle operation already in progress or stale -- use doctor; do not remove a lock until doctor proves it stale

## Messages not received

**Symptoms**: Bot is online but doesn't respond to messages.

**Steps**:

1. Verify the bot token and current-run external health with same-instance doctor
2. For a named Feishu group bot, verify both allowed user and group IDs and `CTI_FEISHU_REQUIRE_MENTION=true`
3. For Telegram: ensure you've sent `/start` to the bot first
4. For Discord: verify the bot has been invited to the server with message read permissions
5. For Feishu: confirm the app has been approved and event subscriptions are configured
6. Check same-instance logs without copying opaque IDs or secrets into a bug report

## Permission timeout

**Symptoms**: Claude Code session starts but times out waiting for tool approval.

**Steps**:

1. The bridge runs Claude Code in non-interactive mode; ensure your Claude Code configuration allows the necessary tools
2. Consider using `--allowedTools` in your configuration to pre-approve common tools
3. Check network connectivity if the timeout occurs during API calls

Codex with `CTI_CODEX_APPROVAL_POLICY=never` never waits for an IM permission response. If such an instance appears to wait for permission, treat it as a configuration mismatch and run doctor; do not add `card.action.trigger` as a workaround.

## High memory usage

**Symptoms**: The daemon process consumes increasing memory over time.

**Steps**:

1. Check current memory usage with same-instance status
2. Restart the daemon to reset memory:
   ```
   CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh stop
   CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh start
   ```
3. If the issue persists, check how many concurrent sessions are active -- each Claude Code session consumes memory
4. Review logs for error loops that may cause memory leaks

## Stale PID file

**Symptoms**: Status shows "running" but the process doesn't exist, or start refuses because it thinks a daemon is already running.

The daemon management script handles stale PID files. If one remains:

1. Run `CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh stop`
2. Run `CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/doctor.sh` and confirm it reports no live process
3. Run `CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/daemon.sh start`

Do not confuse a PID file with the lifecycle lock under `~/.claude-to-im-lifecycle-locks/`.

## Stale lifecycle lock

**Symptoms**: lifecycle commands say another operation is in progress after a crash or power loss.

1. Run `CTI_INSTANCE="$INSTANCE" bash ~/.claude/skills/claude-to-im/scripts/doctor.sh`.
2. If it reports a verified stale lock, copy the exact same-instance `--repair-stale-lock` command it prints.
3. Run doctor again, then retry the original lifecycle command.

Repair is fail closed: it only removes the exact canonical-home lock when its owner record matches the instance, the recorded PID is dead, and the directory contains no unexpected entry or symlink. Never use a broad `rm -rf` on the lock root.

## Codex audit evidence unavailable

Private call-envelope/rollout association files live under the named instance runtime directory. They have no automatic retention/pruning; archive or delete them only while the instance is stopped and according to local policy.

`audit-unavailable` means the bridge could not prove one unambiguous post-checkpoint rollout. Do not use unavailable evidence to justify a same-conditions retry. Rotation/replacement, shrinkage, ambiguous append, and parse failures fail closed. A same-inode file truncated and then regrown beyond its previous size is a known residual boundary; treat that evidence as untrusted rather than equivalent.
