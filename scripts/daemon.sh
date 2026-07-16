#!/usr/bin/env bash
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=instance-env.sh
source "$SKILL_DIR/scripts/instance-env.sh"
CONFIG_FILE="$CTI_HOME/config.env"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
STATUS_FILE="$CTI_HOME/runtime/status.json"
LOG_FILE="$CTI_HOME/logs/bridge.log"

# ── Common helpers ──

ensure_dirs() {
  mkdir -p -m 700 "$CTI_HOME"/{data,logs,runtime,data/messages}
  if [ "$CTI_INSTANCE" != "default" ]; then
    chmod 700 "$CTI_HOME"
    find "$CTI_HOME/data" "$CTI_HOME/logs" "$CTI_HOME/runtime" -type d -exec chmod 700 {} +
    [ ! -f "$CONFIG_FILE" ] || chmod 600 "$CONFIG_FILE"
    [ ! -f "$CTI_INSTANCE_OWNER_FILE" ] || chmod 600 "$CTI_INSTANCE_OWNER_FILE"
    find "$CTI_HOME/data" "$CTI_HOME/logs" "$CTI_HOME/runtime" -type f -exec chmod 600 {} +
  fi
}

verify_instance_ownership() {
  [ "$CTI_INSTANCE" != "default" ] || return 0
  if [ -L "$CTI_INSTANCE_OWNER_FILE" ] || [ ! -f "$CTI_INSTANCE_OWNER_FILE" ] || \
     [ "$(cat "$CTI_INSTANCE_OWNER_FILE" 2>/dev/null)" != "$CTI_INSTANCE" ]; then
    echo "Instance ownership verification failed for $CTI_HOME." >&2
    return 1
  fi
}

claim_instance_ownership() {
  [ "$CTI_INSTANCE" != "default" ] || return 0
  if [ ! -e "$CTI_INSTANCE_OWNER_FILE" ]; then
    local old_umask
    old_umask=$(umask)
    umask 077
    if ! (set -C; printf '%s\n' "$CTI_INSTANCE" > "$CTI_INSTANCE_OWNER_FILE") 2>/dev/null; then
      umask "$old_umask"
      echo "Could not claim instance ownership for $CTI_HOME." >&2
      return 1
    fi
    umask "$old_umask"
  fi
  verify_instance_ownership
  chmod 600 "$CTI_INSTANCE_OWNER_FILE"
}

acquire_lifecycle_lock() {
  local lock_root lock_key
  lock_root="$CTI_HOME_ROOT/.claude-to-im-lifecycle-locks"
  if [ -L "$lock_root" ]; then
    echo "Lifecycle lock root must not be a symlink." >&2
    return 1
  fi
  mkdir -p -m 700 "$lock_root"
  chmod 700 "$lock_root"
  lock_key=$(printf '%s' "$CTI_HOME_CANONICAL" | shasum -a 256 | awk '{print $1}')
  CTI_LIFECYCLE_LOCK="$lock_root/$lock_key.lock"
  if ! mkdir -m 700 "$CTI_LIFECYCLE_LOCK" 2>/dev/null; then
    echo "Lifecycle operation already in progress for this canonical home." >&2
    return 1
  fi
  printf '%s\n%s\n' "$$" "$CTI_INSTANCE" > "$CTI_LIFECYCLE_LOCK/owner"
  chmod 600 "$CTI_LIFECYCLE_LOCK/owner"
  CTI_LIFECYCLE_LOCK_HELD=1
  install_exit_guard
}

release_lifecycle_lock() {
  [ "${CTI_LIFECYCLE_LOCK_HELD:-0}" = "1" ] || return 0
  rm -rf -- "$CTI_LIFECYCLE_LOCK"
  CTI_LIFECYCLE_LOCK_HELD=0
}

default_config_fingerprint() {
  local default_config="$HOME/.claude-to-im/config.env"
  if [ -f "$default_config" ]; then
    shasum -a 256 "$default_config" | awk '{print "present:" $1}'
  else
    echo "missing"
  fi
}

guard_default_instance() {
  [ "$CTI_INSTANCE" != "default" ] || return 0
  CTI_DEFAULT_CONFIG_BEFORE="$(default_config_fingerprint)"
  install_exit_guard
}

install_exit_guard() {
  trap 'cti_on_exit' EXIT
}

cti_on_exit() {
  local exit_code=$?
  trap - EXIT
  if [ -n "${CTI_DEFAULT_CONFIG_BEFORE:-}" ] && \
     [ "$(default_config_fingerprint)" != "$CTI_DEFAULT_CONFIG_BEFORE" ]; then
    echo "Default instance config changed during named operation; refusing further action." >&2
    exit_code=1
  fi
  release_lifecycle_lock
  exit "$exit_code"
}

ensure_built() {
  local need_build=0
  if [ ! -f "$SKILL_DIR/dist/daemon.mjs" ]; then
    need_build=1
  else
    # Check if any source file is newer than the bundle
    local newest_src
    newest_src=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
    if [ -n "$newest_src" ]; then
      need_build=1
    fi
    # Also check if node_modules/claude-to-im was updated (npm update)
    # — its code is bundled into dist, so changes require a rebuild
    if [ "$need_build" = "0" ] && [ -d "$SKILL_DIR/node_modules/claude-to-im/src" ]; then
      local newest_dep
      newest_dep=$(find "$SKILL_DIR/node_modules/claude-to-im/src" -name '*.ts' -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
      if [ -n "$newest_dep" ]; then
        need_build=1
      fi
    fi
  fi
  if [ "$need_build" = "1" ]; then
    echo "Building daemon bundle..."
    (cd "$SKILL_DIR" && npm run build)
  fi
}

config_preflight() {
  (cd "$SKILL_DIR" && node --import tsx src/config-preflight.ts)
}

# Clean environment for subprocess isolation.
clean_env() {
  unset CLAUDECODE 2>/dev/null || true

  local runtime
  runtime=$(grep "^CTI_RUNTIME=" "$CTI_HOME/config.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"' || true)
  runtime="${runtime:-claude}"

  local mode="${CTI_ENV_ISOLATION:-inherit}"
  if [ "$mode" = "strict" ]; then
    case "$runtime" in
      codex)
        while IFS='=' read -r name _; do
          case "$name" in ANTHROPIC_*) unset "$name" 2>/dev/null || true ;; esac
        done < <(env)
        ;;
      claude)
        # Keep ANTHROPIC_* (from config.env) — needed for third-party API providers.
        # Strip OPENAI_* to avoid cross-runtime leakage.
        while IFS='=' read -r name _; do
          case "$name" in OPENAI_*) unset "$name" 2>/dev/null || true ;; esac
        done < <(env)
        ;;
      auto)
        # Keep both ANTHROPIC_* and OPENAI_* for auto mode
        ;;
    esac
  fi
}

read_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || echo ""
}

pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

status_running() {
  [ -f "$STATUS_FILE" ] && grep -q '"running"[[:space:]]*:[[:space:]]*true' "$STATUS_FILE" 2>/dev/null
}

show_last_exit_reason() {
  if [ -f "$STATUS_FILE" ]; then
    local reason
    reason=$(grep -o '"lastExitReason"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_FILE" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"$//')
    [ -n "$reason" ] && echo "Last exit reason: $reason"
  fi
}

show_failure_help() {
  echo ""
  echo "Recent logs:"
  tail -20 "$LOG_FILE" 2>/dev/null || echo "  (no log file)"
  echo ""
  echo "Next steps:"
  echo "  1. Run diagnostics:  bash \"$SKILL_DIR/scripts/doctor.sh\""
  echo "  2. Check full logs:  bash \"$SKILL_DIR/scripts/daemon.sh\" logs 100"
  echo "  3. Rebuild bundle:   cd \"$SKILL_DIR\" && npm run build"
}

# ── Load platform-specific supervisor ──

case "$(uname -s)" in
  Darwin)
    # shellcheck source=supervisor-macos.sh
    source "$SKILL_DIR/scripts/supervisor-macos.sh"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Windows detected via Git Bash / MSYS2 / Cygwin — delegate to PowerShell
    echo "Windows detected. Delegating to supervisor-windows.ps1..."
    powershell.exe -ExecutionPolicy Bypass -File "$SKILL_DIR/scripts/supervisor-windows.ps1" "$@"
    exit $?
    ;;
  *)
    # shellcheck source=supervisor-linux.sh
    source "$SKILL_DIR/scripts/supervisor-linux.sh"
    ;;
esac

guard_default_instance

# ── Commands ──

case "${1:-help}" in
  start)
    if [ ! -f "$CONFIG_FILE" ]; then
      echo "Config missing: $CONFIG_FILE" >&2
      exit 1
    fi
    config_preflight
    acquire_lifecycle_lock
    ensure_dirs
    claim_instance_ownership
    ensure_built

    # Check if already running (supervisor-aware: launchctl on macOS, PID on Linux)
    if supervisor_is_running; then
      EXISTING_PID=$(read_pid)
      echo "Bridge already running${EXISTING_PID:+ (PID: $EXISTING_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
      exit 1
    fi

    # Source config.env BEFORE clean_env so that CTI_ANTHROPIC_PASSTHROUGH
    # and other CTI_* flags are available when clean_env checks them.
    CTI_RESOLVED_INSTANCE="$CTI_INSTANCE"
    CTI_RESOLVED_HOME="$CTI_HOME"
    CTI_RESOLVED_LABEL="$CTI_LAUNCHD_LABEL"
    set -a
    source "$CONFIG_FILE"
    set +a
    CTI_INSTANCE="$CTI_RESOLVED_INSTANCE"
    CTI_HOME="$CTI_RESOLVED_HOME"
    CTI_LAUNCHD_LABEL="$CTI_RESOLVED_LABEL"
    export CTI_INSTANCE CTI_HOME CTI_LAUNCHD_LABEL

    clean_env
    echo "Starting bridge..."
    supervisor_start

    # Poll for up to 10 seconds waiting for status.json to report running
    STARTED=false
    for _ in $(seq 1 10); do
      sleep 1
      if status_running; then
        STARTED=true
        break
      fi
      # If supervisor process already died, stop waiting
      if ! supervisor_is_running; then
        break
      fi
    done

    if [ "$STARTED" = "true" ]; then
      NEW_PID=$(read_pid)
      echo "Bridge started${NEW_PID:+ (PID: $NEW_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Failed to start bridge."
      supervisor_is_running || echo "  Process not running."
      status_running || echo "  status.json not reporting running=true."
      show_last_exit_reason
      show_failure_help
      exit 1
    fi
    ;;

  stop)
    acquire_lifecycle_lock
    verify_instance_ownership
    if supervisor_is_managed; then
      echo "Stopping bridge..."
      supervisor_stop
      echo "Bridge stopped"
    else
      PID=$(read_pid)
      if [ -z "$PID" ]; then echo "No bridge running"; exit 0; fi
      if pid_alive "$PID"; then
        kill "$PID"
        for _ in $(seq 1 10); do
          pid_alive "$PID" || break
          sleep 1
        done
        pid_alive "$PID" && kill -9 "$PID"
        echo "Bridge stopped"
      else
        echo "Bridge was not running (stale PID file)"
      fi
      rm -f "$PID_FILE"
    fi
    ;;

  status)
    echo "Instance: $CTI_INSTANCE"
    echo "Home: $CTI_HOME"
    echo "Label: $CTI_LAUNCHD_LABEL"

    # Platform-specific status info (prints launchd/service state)
    supervisor_status_extra

    # Process status: supervisor-aware (launchctl on macOS, PID on Linux)
    if supervisor_is_running; then
      PID=$(read_pid)
      echo "Bridge process is running${PID:+ (PID: $PID)}"
      # Business status from status.json
      if status_running; then
        echo "Bridge status: running"
      else
        echo "Bridge status: process alive but status.json not reporting running"
      fi
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Bridge is not running"
      show_last_exit_reason
    fi
    ;;

  logs)
    N="${2:-50}"
    tail -n "$N" "$LOG_FILE" 2>/dev/null | sed -E 's/(token|secret|password)(["\\x27]?\s*[:=]\s*["\\x27]?)[^ "]+/\1\2*****/gi'
    ;;

  uninstall)
    acquire_lifecycle_lock
    verify_instance_ownership
    echo "Uninstalling instance $CTI_INSTANCE..."
    supervisor_uninstall
    echo "LaunchAgent uninstalled; home preserved: $CTI_HOME"
    ;;

  remove)
    if [ "$CTI_INSTANCE" = "default" ]; then
      echo "Refusing to remove the default instance." >&2
      exit 1
    fi
    if [ "${2:-}" != "$CTI_INSTANCE" ]; then
      echo "Removal confirmation must exactly match instance: $CTI_INSTANCE" >&2
      exit 1
    fi
    acquire_lifecycle_lock
    verify_instance_ownership
    if supervisor_is_managed || supervisor_is_running; then
      echo "Instance must be stopped and unregistered before removal." >&2
      exit 1
    fi
    verify_instance_ownership
    if supervisor_is_managed || supervisor_is_running; then
      echo "Instance state changed during removal; refusing deletion." >&2
      exit 1
    fi
    rm -rf -- "$CTI_HOME"
    echo "Removed instance home: $CTI_HOME"
    ;;

  *)
    echo "Usage: daemon.sh {start|stop|status|logs [N]|uninstall|remove INSTANCE}"
    ;;
esac
