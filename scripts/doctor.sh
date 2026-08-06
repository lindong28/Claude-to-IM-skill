#!/usr/bin/env bash
set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=instance-env.sh
source "$SKILL_DIR/scripts/instance-env.sh"
CONFIG_FILE="$CTI_HOME/config.env"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
STATUS_FILE="$CTI_HOME/runtime/status.json"
LOG_FILE="$CTI_HOME/logs/bridge.log"
PLIST_FILE="$HOME/Library/LaunchAgents/$CTI_LAUNCHD_LABEL.plist"

PASS=0
FAIL=0

case "${1:-}" in
  "") ;;
  --repair-stale-lock) ;;
  *)
    echo "Usage: doctor.sh [--repair-stale-lock]" >&2
    exit 64
    ;;
esac

echo "Instance: $CTI_INSTANCE"
echo "Home: $CTI_HOME"
echo "Label: $CTI_LAUNCHD_LABEL"
echo "Plist: $PLIST_FILE"
echo ""

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "[OK]   $label"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $label"
    FAIL=$((FAIL + 1))
  fi
}

lifecycle_lock_path() {
  local lock_key
  lock_key=$(printf '%s' "$CTI_HOME_CANONICAL" | shasum -a 256 | awk '{print $1}')
  printf '%s/.claude-to-im-lifecycle-locks/%s.lock\n' "$CTI_HOME_ROOT" "$lock_key"
}

validated_stat() {
  local gnu_format="$1"
  local bsd_format="$2"
  local pattern="$3"
  local path="$4"
  local value

  value=$(stat -c "$gnu_format" "$path" 2>/dev/null || true)
  if [[ "$value" =~ $pattern ]]; then
    printf '%s\n' "$value"
    return 0
  fi

  value=$(stat -f "$bsd_format" "$path" 2>/dev/null || true)
  if [[ "$value" =~ $pattern ]]; then
    printf '%s\n' "$value"
    return 0
  fi

  return 1
}

stat_identity() {
  validated_stat '%d:%i' '%d:%i' '^[0-9]+:[0-9]+$' "$1"
}

stat_mode() {
  local value
  value=$(stat -c '%a' "$1" 2>/dev/null || true)
  if [[ "$value" =~ ^[0-7]{3}$ ]]; then
    printf '0%s\n' "$value"
    return 0
  fi
  if [[ "$value" =~ ^[0-7]{4}$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi

  value=$(stat -f '%p' "$1" 2>/dev/null || true)
  if [[ "$value" =~ ^[0-7]{5,7}$ ]]; then
    printf '%s\n' "${value: -4}"
    return 0
  fi
  return 1
}

feishu_api_origin() {
  if [ "${1:-}" = "lark" ]; then
    printf '%s\n' 'https://open.larksuite.com'
  else
    printf '%s\n' 'https://open.feishu.cn'
  fi
}

repair_stale_lifecycle_lock() (
  set -e
  local lock_path lock_root lock_name expected_root expected_lock lock_identity owner_identity
  local owner_pid owner_instance entry_count
  lock_path=$(lifecycle_lock_path)
  lock_root=$(dirname "$lock_path")
  lock_name=$(basename "$lock_path")
  expected_root="$lock_root"
  expected_lock="$lock_path"

  refuse_repair() {
    echo "Refusing lifecycle-lock repair: lock path or owner changed during verification." >&2
    exit 1
  }

  verify_pinned_lock() {
    [ ! -L ./owner ] && [ -f ./owner ] || refuse_repair
    entry_count=$(find . -mindepth 1 -maxdepth 1 -print 2>/dev/null | wc -l | tr -d ' ')
    [ "$entry_count" = "1" ] || refuse_repair
    owner_pid=$(sed -n '1p' ./owner 2>/dev/null || true)
    owner_instance=$(sed -n '2p' ./owner 2>/dev/null || true)
    [[ "$owner_pid" =~ ^[0-9]+$ ]] || refuse_repair
    [ "$owner_instance" = "$CTI_INSTANCE" ] || refuse_repair
    [ -z "$(sed -n '3p' ./owner 2>/dev/null || true)" ] || refuse_repair
    if kill -0 "$owner_pid" 2>/dev/null; then
      echo "Refusing lifecycle-lock repair: owner PID is still active." >&2
      exit 1
    fi
  }

  [ ! -L "$lock_root" ] && [ -d "$lock_root" ] || refuse_repair
  cd -P "$lock_root"
  [ "$(pwd -P)" = "$expected_root" ] || refuse_repair
  [ ! -L "$lock_name" ] && [ -d "$lock_name" ] || refuse_repair
  cd -P "$lock_name"
  [ "$(pwd -P)" = "$expected_lock" ] || refuse_repair
  lock_identity=$(stat_identity .) || refuse_repair
  verify_pinned_lock
  owner_identity=$(stat_identity ./owner) || refuse_repair

  # Revalidate the pinned directory and owner immediately before deletion.
  [ "$(stat_identity .)" = "$lock_identity" ] || refuse_repair
  verify_pinned_lock
  [ "$(stat_identity ./owner)" = "$owner_identity" ] || refuse_repair

  # Relative deletion is anchored to the already-open physical cwd. A swap of
  # the external lock path cannot redirect this operation through a symlink.
  rm -- ./owner
  cd -P ..

  # rmdir never follows symlinks; require the external entry to still be the
  # exact directory verified above before removing it.
  [ ! -L "$lock_name" ] && [ -d "$lock_name" ] || refuse_repair
  [ "$(stat_identity "$lock_name")" = "$lock_identity" ] || refuse_repair
  rmdir -- "$lock_name"
)

inspect_lifecycle_lock() {
  local lock_path="$1"
  local lock_root
  lock_root=$(dirname "$lock_path")
  CTI_LOCK_STATE="absent"
  CTI_LOCK_OWNER_PID=""
  CTI_LOCK_OWNER_INSTANCE=""

  if [ -L "$lock_root" ] || { [ -e "$lock_root" ] && [ ! -d "$lock_root" ]; }; then
    CTI_LOCK_STATE="unsafe"
    return 0
  fi
  [ -e "$lock_path" ] || [ -L "$lock_path" ] || return 0
  if [ -L "$lock_path" ] || [ ! -d "$lock_path" ] || \
     [ -L "$lock_path/owner" ] || [ ! -f "$lock_path/owner" ]; then
    CTI_LOCK_STATE="unsafe"
    return 0
  fi
  if [ "$(find "$lock_path" -mindepth 1 -maxdepth 1 -print 2>/dev/null | wc -l | tr -d ' ')" != "1" ]; then
    CTI_LOCK_STATE="unsafe"
    return 0
  fi

  CTI_LOCK_OWNER_PID=$(sed -n '1p' "$lock_path/owner" 2>/dev/null || true)
  CTI_LOCK_OWNER_INSTANCE=$(sed -n '2p' "$lock_path/owner" 2>/dev/null || true)
  if ! [[ "$CTI_LOCK_OWNER_PID" =~ ^[0-9]+$ ]] || \
     [ "$CTI_LOCK_OWNER_INSTANCE" != "$CTI_INSTANCE" ] || \
     [ -n "$(sed -n '3p' "$lock_path/owner" 2>/dev/null || true)" ]; then
    CTI_LOCK_STATE="unsafe"
  elif kill -0 "$CTI_LOCK_OWNER_PID" 2>/dev/null; then
    CTI_LOCK_STATE="active"
  else
    CTI_LOCK_STATE="stale"
  fi
}

LIFECYCLE_LOCK_PATH=$(lifecycle_lock_path)
inspect_lifecycle_lock "$LIFECYCLE_LOCK_PATH"
if [ "${1:-}" = "--repair-stale-lock" ]; then
  if [ "$CTI_LOCK_STATE" != "stale" ]; then
    echo "Refusing lifecycle-lock repair: state is $CTI_LOCK_STATE (expected stale)." >&2
    exit 1
  fi
  repair_stale_lifecycle_lock
  echo "Removed verified stale lifecycle lock for instance $CTI_INSTANCE."
  exit 0
fi

# --- Node.js version ---
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ] 2>/dev/null; then
    check "Node.js >= 20 (found v$(node -v | sed 's/v//'))" 0
  else
    check "Node.js >= 20 (found v$(node -v | sed 's/v//'), need >= 20)" 1
  fi
else
  check "Node.js installed" 1
fi

# --- Helper: read a value from config.env ---
get_config() {
  [ -r "$CONFIG_FILE" ] || return 0
  awk -v target="$1" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    {
      line = trim($0)
      if (line == "" || substr(line, 1, 1) == "#") next
      separator = index(line, "=")
      if (separator == 0) next
      key = trim(substr(line, 1, separator - 1))
      if (key != target) next
      value = trim(substr(line, separator + 1))
      first = substr(value, 1, 1)
      last = substr(value, length(value), 1)
      if (length(value) >= 2 && ((first == "\"" && last == "\"") || (first == "\047" && last == "\047"))) {
        value = substr(value, 2, length(value) - 2)
      }
      found = 1
      result = value
    }
    END {
      if (found) printf "%s", result
    }
  ' "$CONFIG_FILE" 2>/dev/null || true
}

# --- Read runtime setting ---
CTI_RUNTIME=$(get_config CTI_RUNTIME)
CTI_RUNTIME="${CTI_RUNTIME:-claude}"
echo "Runtime: $CTI_RUNTIME"
echo ""

# --- Claude CLI available (claude/auto modes) ---
if [ "$CTI_RUNTIME" = "claude" ] || [ "$CTI_RUNTIME" = "auto" ]; then
  # Resolve CLI path matching the daemon's checkCliCompatibility logic:
  #   - Version >= 2.x AND all required flags present
  #   - Skip candidates that fail either check (same as resolveClaudeCliPath)
  CLAUDE_PATH=""
  CLAUDE_VER=""
  CLAUDE_COMPAT=1
  REQUIRED_FLAGS="output-format input-format permission-mode setting-sources"

  # Helper: check if a candidate passes both version and flags checks.
  # Sets CLAUDE_PATH/CLAUDE_VER/CLAUDE_COMPAT on success.
  try_candidate() {
    local cand="$1"
    [ -x "$cand" ] || return 1
    local ver
    ver=$("$cand" --version 2>/dev/null || true)
    [ -z "$ver" ] && return 1
    local major
    major=$(echo "$ver" | sed -E -n 's/^[^0-9]*([0-9]+)\..*/\1/p' | head -1)
    if [ -z "$major" ] || ! [ "$major" -ge 2 ] 2>/dev/null; then
      echo "  (skipping $cand — version $ver is too old, need >= 2.x)"
      return 1
    fi
    # Version OK — check flags
    local help_text
    help_text=$("$cand" --help 2>&1 || true)
    for flag in $REQUIRED_FLAGS; do
      if ! echo "$help_text" | grep -q "$flag"; then
        echo "  (skipping $cand — version $ver OK but missing --$flag)"
        return 1
      fi
    done
    # Fully compatible
    CLAUDE_PATH="$cand"
    CLAUDE_VER="$ver"
    CLAUDE_COMPAT=0
    return 0
  }

  # 1. Explicit env var — if set, daemon uses it unconditionally (no fallback).
  #    Doctor must mirror this: report on this path only, never scan further.
  CTI_EXE=$(get_config CTI_CLAUDE_CODE_EXECUTABLE 2>/dev/null || true)
  if [ -n "$CTI_EXE" ]; then
    if [ -x "$CTI_EXE" ]; then
      if ! try_candidate "$CTI_EXE"; then
        # Explicit path is set but incompatible — daemon WILL use it and fail.
        # Report it as the selected CLI so the user sees the real problem.
        CLAUDE_PATH="$CTI_EXE"
        CLAUDE_VER=$("$CTI_EXE" --version 2>/dev/null || echo "unknown")
        # CLAUDE_COMPAT stays 1 (incompatible) — checks below will report failure
      fi
    else
      CLAUDE_PATH="$CTI_EXE"
      CLAUDE_VER="(not executable)"
    fi
  fi

  # 2. All PATH candidates (only if no explicit env var was set)
  if [ -z "$CTI_EXE" ] && [ -z "$CLAUDE_PATH" ]; then
    ALL_CLAUDES=$(which -a claude 2>/dev/null || true)
    for cand in $ALL_CLAUDES; do
      try_candidate "$cand" && break
    done
  fi

  # 3. Well-known locations (only if no explicit env var was set)
  if [ -z "$CTI_EXE" ] && [ -z "$CLAUDE_PATH" ]; then
    for cand in \
      "$HOME/.claude/local/claude" \
      "$HOME/.local/bin/claude" \
      "/usr/local/bin/claude" \
      "/opt/homebrew/bin/claude" \
      "$HOME/.npm-global/bin/claude"; do
      try_candidate "$cand" && break
    done
  fi

  if [ -n "$CLAUDE_PATH" ] && [ "$CLAUDE_COMPAT" = "0" ]; then
    check "Claude CLI compatible (${CLAUDE_VER} at ${CLAUDE_PATH})" 0
  elif [ -n "$CLAUDE_PATH" ]; then
    # Path found but incompatible (too old, missing flags, or not executable)
    check "Claude CLI compatible (${CLAUDE_VER} at ${CLAUDE_PATH} — incompatible, see above)" 1
  else
    if [ "$CTI_RUNTIME" = "claude" ]; then
      check "Claude CLI available (not found in PATH or common locations)" 1
    else
      check "Claude CLI available (not found — will use Codex fallback)" 0
    fi
  fi

  # --- Claude CLI authenticated ---
  # Skip this check if third-party API credentials are configured in config.env.
  # In that mode the bridge authenticates via ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN,
  # not via `claude auth login`, so a missing interactive login is expected and harmless.
  HAS_THIRD_PARTY_AUTH=false
  if [ -f "$CONFIG_FILE" ] && grep -qE "^ANTHROPIC_(API_KEY|AUTH_TOKEN)=" "$CONFIG_FILE" 2>/dev/null; then
    HAS_THIRD_PARTY_AUTH=true
  fi
  if [ -n "$CLAUDE_PATH" ] && [ "$CLAUDE_COMPAT" = "0" ]; then
    if [ "$HAS_THIRD_PARTY_AUTH" = "true" ]; then
      check "Claude CLI auth (skipped — using third-party API credentials from config.env)" 0
    else
      AUTH_OUT=$("$CLAUDE_PATH" auth status 2>&1 || true)
      if echo "$AUTH_OUT" | grep -qiE 'loggedIn.*true|logged.in'; then
        check "Claude CLI authenticated" 0
      else
        check "Claude CLI authenticated (run 'claude auth login')" 1
      fi
    fi
  fi

  # --- ANTHROPIC_* env reachability ---
  # Check whether ANTHROPIC_* vars are configured in config.env.
  # This is what matters for the daemon — the current shell env is irrelevant
  # because on macOS the daemon runs under launchd with only plist env vars.
  HAS_ANTHROPIC_CONFIG=false
  if [ -f "$CONFIG_FILE" ]; then
    if grep -q "^ANTHROPIC_" "$CONFIG_FILE" 2>/dev/null; then
      HAS_ANTHROPIC_CONFIG=true
    fi
  fi
  if [ "$HAS_ANTHROPIC_CONFIG" = "true" ]; then
    check "ANTHROPIC_* vars in config.env (third-party API provider)" 0

    # Credentials must be loaded from config.env by the process, never copied
    # into a launchd plist.
    if [ "$(uname -s)" = "Darwin" ] && [ -f "$PLIST_FILE" ]; then
      if grep -q "ANTHROPIC_" "$PLIST_FILE" 2>/dev/null; then
        check "ANTHROPIC_* vars absent from launchd plist" 1
      else
        check "ANTHROPIC_* vars absent from launchd plist" 0
      fi
    fi
  else
    check "ANTHROPIC_* vars in config.env (not set — OK if using default Anthropic auth)" 0
  fi

  # --- SDK cli.js resolvable ---
  SDK_CLI=""
  for candidate in \
    "$SKILL_DIR/node_modules/@anthropic-ai/claude-agent-sdk/cli.js" \
    "$SKILL_DIR/node_modules/@anthropic-ai/claude-agent-sdk/dist/cli.js"; do
    if [ -f "$candidate" ]; then
      SDK_CLI="$candidate"
      break
    fi
  done
  if [ -n "$SDK_CLI" ]; then
    check "Claude SDK cli.js exists ($SDK_CLI)" 0
  else
    if [ "$CTI_RUNTIME" = "claude" ]; then
      check "Claude SDK cli.js exists (not found — run 'npm install' in $SKILL_DIR)" 1
    else
      check "Claude SDK cli.js exists (not found — OK for auto/codex mode)" 0
    fi
  fi
fi

# --- Named-instance private persistence boundary ---
if [ "$CTI_INSTANCE" != "default" ]; then
  HOME_PERMS=$(stat_mode "$CTI_HOME" || echo "missing")
  if [ "$HOME_PERMS" = "0700" ]; then
    check "Named instance home permissions are 700" 0
  else
    check "Named instance home permissions are 700 (currently $HOME_PERMS)" 1
  fi

  BAD_DIRS=""
  BAD_FILES=""
  for dir in "$CTI_HOME/data" "$CTI_HOME/runtime" "$CTI_HOME/logs"; do
    [ ! -d "$dir" ] || BAD_DIRS+="$(find "$dir" -type d ! -perm 700 -print 2>/dev/null)"
    [ ! -d "$dir" ] || BAD_FILES+="$(find "$dir" -type f ! -perm 600 -print 2>/dev/null)"
  done
  if [ -z "$BAD_DIRS" ]; then
    check "Named data/runtime/log directories are 700" 0
  else
    check "Named data/runtime/log directories are 700" 1
  fi
  if [ -z "$BAD_FILES" ]; then
    check "Named data/runtime/log files are 600" 0
  else
    check "Named data/runtime/log files are 600" 1
  fi
fi

# --- Lifecycle operation lock ---
case "$CTI_LOCK_STATE" in
  absent)
    check "Lifecycle operation lock is clear" 0
    ;;
  active)
    check "Lifecycle operation lock is clear (operation owned by live PID $CTI_LOCK_OWNER_PID)" 1
    ;;
  stale)
    check "Lifecycle operation lock is clear (verified stale lock; repair with: CTI_INSTANCE=$CTI_INSTANCE bash '$SKILL_DIR/scripts/doctor.sh' --repair-stale-lock)" 1
    ;;
  *)
    check "Lifecycle operation lock is structurally safe (manual inspection required; automatic repair refused)" 1
    ;;
esac

# --- Codex checks (codex/auto modes) ---
if [ "$CTI_RUNTIME" = "codex" ] || [ "$CTI_RUNTIME" = "auto" ]; then
  CODEX_SANDBOX_POLICY=$(get_config CTI_CODEX_SANDBOX_MODE)
  CODEX_APPROVAL_POLICY=$(get_config CTI_CODEX_APPROVAL_POLICY)
  CODEX_NETWORK_POLICY=$(get_config CTI_CODEX_NETWORK_ACCESS)
  CODEX_POLICY_CONFIG_VALID=0
  case "$CODEX_SANDBOX_POLICY" in
    "") CODEX_SANDBOX_POLICY="inherited" ;;
    read-only|workspace-write|danger-full-access) ;;
    *) CODEX_SANDBOX_POLICY="invalid"; CODEX_POLICY_CONFIG_VALID=1 ;;
  esac
  case "$CODEX_APPROVAL_POLICY" in
    "") CODEX_APPROVAL_POLICY="derived-from-permission-mode" ;;
    untrusted|on-failure|on-request|never) ;;
    *) CODEX_APPROVAL_POLICY="invalid"; CODEX_POLICY_CONFIG_VALID=1 ;;
  esac
  case "$CODEX_NETWORK_POLICY" in
    "") CODEX_NETWORK_POLICY="inherited" ;;
    true|false) ;;
    *) CODEX_NETWORK_POLICY="invalid"; CODEX_POLICY_CONFIG_VALID=1 ;;
  esac
  echo "Codex effective policy: sandbox=$CODEX_SANDBOX_POLICY, approval=$CODEX_APPROVAL_POLICY, network=$CODEX_NETWORK_POLICY"
  check "Codex execution policy config values are valid" "$CODEX_POLICY_CONFIG_VALID"

  if command -v codex &>/dev/null; then
    CODEX_VER=$(codex --version 2>/dev/null || echo "unknown")
    check "Codex CLI available (${CODEX_VER})" 0
  else
    if [ "$CTI_RUNTIME" = "codex" ]; then
      check "Codex CLI available (not found in PATH)" 1
    else
      check "Codex CLI available (not found — will use Claude)" 0
    fi
  fi

  # Check @openai/codex-sdk
  CODEX_SDK="$SKILL_DIR/node_modules/@openai/codex-sdk"
  if [ -d "$CODEX_SDK" ]; then
    check "@openai/codex-sdk installed" 0
  else
    if [ "$CTI_RUNTIME" = "codex" ]; then
      check "@openai/codex-sdk installed (not found — run 'npm install' in $SKILL_DIR)" 1
    else
      check "@openai/codex-sdk installed (not found — OK for auto/claude mode)" 0
    fi
  fi

  # Check Codex auth: any configured API key, or `codex login status`
  # showing logged-in (interactive login).
  CODEX_AUTH=1
  if [ -n "$(get_config CTI_CODEX_API_KEY)" ] || [ -n "$(get_config CODEX_API_KEY)" ] || \
     [ -n "$(get_config OPENAI_API_KEY)" ] || [ -n "${CTI_CODEX_API_KEY:-}" ] || \
     [ -n "${CODEX_API_KEY:-}" ] || [ -n "${OPENAI_API_KEY:-}" ]; then
    CODEX_AUTH=0
  elif command -v codex &>/dev/null; then
    CODEX_AUTH_OUT=$(codex login status 2>&1 || true)
    if echo "$CODEX_AUTH_OUT" | grep -qiE 'logged in|authenticated' && \
       ! echo "$CODEX_AUTH_OUT" | grep -qiE 'not logged in|unauthenticated'; then
      CODEX_AUTH=0
    fi
  fi
  if [ "$CODEX_AUTH" = "0" ]; then
    check "Codex auth available (API key or login)" 0
  else
    if [ "$CTI_RUNTIME" = "codex" ]; then
      check "Codex auth available (set OPENAI_API_KEY or run 'codex login')" 1
    else
      check "Codex auth available (not found — needed only for Codex fallback)" 0
    fi
  fi
fi

# --- dist/daemon.mjs freshness ---
DAEMON_MJS="$SKILL_DIR/dist/daemon.mjs"
if [ -f "$DAEMON_MJS" ]; then
  STALE_SRC=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$DAEMON_MJS" 2>/dev/null | head -1)
  if [ -z "$STALE_SRC" ]; then
    check "dist/daemon.mjs is up to date" 0
  else
    check "dist/daemon.mjs is stale (src changed, run 'npm run build')" 1
  fi
else
  check "dist/daemon.mjs exists (not built — run 'npm run build')" 1
fi

# --- config.env exists ---
if [ -f "$CONFIG_FILE" ]; then
  check "config.env exists" 0
else
  check "config.env exists ($CONFIG_FILE not found)" 1
fi

# --- config.env permissions ---
if [ -f "$CONFIG_FILE" ]; then
  PERMS=$(stat_mode "$CONFIG_FILE" || echo "unknown")
  if [ "$PERMS" = "0600" ]; then
    check "config.env permissions are 600" 0
  else
    check "config.env permissions are 600 (currently $PERMS)" 1
  fi
fi

# --- Load config for channel checks ---
if [ -f "$CONFIG_FILE" ]; then
  CTI_CHANNELS=$(get_config CTI_ENABLED_CHANNELS)

  # --- Telegram ---
  if echo "$CTI_CHANNELS" | grep -q telegram; then
    TG_TOKEN=$(get_config CTI_TG_BOT_TOKEN)
    if [ -n "$TG_TOKEN" ]; then
      TG_RESULT=$(curl -s --max-time 5 "https://api.telegram.org/bot${TG_TOKEN}/getMe" 2>/dev/null || echo '{"ok":false}')
      if echo "$TG_RESULT" | grep -q '"ok":true'; then
        check "Telegram bot token is valid" 0
      else
        check "Telegram bot token is valid (getMe failed)" 1
      fi
    else
      check "Telegram bot token configured" 1
    fi
  fi

  # --- Feishu ---
  if echo "$CTI_CHANNELS" | grep -q feishu; then
    FS_APP_ID=$(get_config CTI_FEISHU_APP_ID)
    FS_SECRET=$(get_config CTI_FEISHU_APP_SECRET)
    FS_DOMAIN=$(get_config CTI_FEISHU_DOMAIN)
    FS_API_ORIGIN=$(feishu_api_origin "$FS_DOMAIN")
    FS_GROUP_POLICY=$(get_config CTI_FEISHU_GROUP_POLICY)
    FS_REQUIRE_MENTION=$(get_config CTI_FEISHU_REQUIRE_MENTION)
    FS_ALLOWED_USERS=$(get_config CTI_FEISHU_ALLOWED_USERS)
    FS_ALLOWED_GROUPS=$(get_config CTI_FEISHU_GROUP_ALLOW_FROM)

    case "$FS_DOMAIN" in
      ""|lark|feishu) check "CTI_FEISHU_DOMAIN is lark, feishu, or unset" 0 ;;
      *) check "CTI_FEISHU_DOMAIN is lark, feishu, or unset" 1 ;;
    esac

    if [ "$CTI_INSTANCE" != "default" ]; then
    if [ "$FS_GROUP_POLICY" = "allowlist" ]; then
      check "Feishu group policy is allowlist" 0
    else
      check "Feishu group policy is allowlist" 1
    fi
    FS_USER_COUNT=$(printf '%s' "$FS_ALLOWED_USERS" | awk -F, '{n=0; for(i=1;i<=NF;i++) if($i!="") n++; print n}')
    FS_GROUP_COUNT=$(printf '%s' "$FS_ALLOWED_GROUPS" | awk -F, '{n=0; for(i=1;i<=NF;i++) if($i!="") n++; print n}')
    if [ "$FS_USER_COUNT" -gt 0 ] 2>/dev/null; then
      check "Feishu allowed users configured (count: $FS_USER_COUNT)" 0
    else
      check "Feishu allowed users configured (count: 0)" 1
    fi
    if [ "$FS_GROUP_COUNT" -gt 0 ] 2>/dev/null; then
      check "Feishu allowed groups configured (count: $FS_GROUP_COUNT)" 0
    else
      check "Feishu allowed groups configured (count: 0)" 1
    fi
    if [ "$FS_REQUIRE_MENTION" = "true" ]; then
      check "Feishu require mention is true" 0
    else
      check "Feishu require mention is true" 1
    fi

    PLIST_SENSITIVE=0
    if [ -f "$PLIST_FILE" ]; then
      if grep -qE 'CTI_FEISHU_APP_SECRET|CTI_FEISHU_ALLOWED_USERS|CTI_FEISHU_GROUP_ALLOW_FROM' "$PLIST_FILE" 2>/dev/null; then
        PLIST_SENSITIVE=1
      fi
      for value in "$FS_SECRET" ${FS_ALLOWED_USERS//,/ } ${FS_ALLOWED_GROUPS//,/ }; do
        [ -z "$value" ] || ! grep -Fq -- "$value" "$PLIST_FILE" 2>/dev/null || PLIST_SENSITIVE=1
      done
    fi
    if [ "$PLIST_SENSITIVE" -eq 0 ]; then
      check "Named plist excludes Feishu sensitive keys and values" 0
    else
      check "Named plist excludes Feishu sensitive keys and values" 1
    fi
    fi
    if [ -n "$FS_APP_ID" ] && [ -n "$FS_SECRET" ]; then
      FEISHU_RESULT=$(curl -s --max-time 5 -X POST "${FS_API_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal" \
        -H "Content-Type: application/json" \
        -d "{\"app_id\":\"${FS_APP_ID}\",\"app_secret\":\"${FS_SECRET}\"}" 2>/dev/null || echo '{"code":1}')
      if echo "$FEISHU_RESULT" | grep -q '"code"[[:space:]]*:[[:space:]]*0'; then
        check "Feishu app credentials are valid" 0
      else
        check "Feishu app credentials are valid (token request failed)" 1
      fi
    else
      check "Feishu app credentials configured" 1
    fi
  fi

  # --- QQ ---
  if echo "$CTI_CHANNELS" | grep -q qq; then
    QQ_APP_ID=$(get_config CTI_QQ_APP_ID)
    QQ_APP_SECRET=$(get_config CTI_QQ_APP_SECRET)
    if [ -n "$QQ_APP_ID" ] && [ -n "$QQ_APP_SECRET" ]; then
      QQ_TOKEN_RESULT=$(curl -s --max-time 10 -X POST "https://bots.qq.com/app/getAppAccessToken" \
        -H "Content-Type: application/json" \
        -d "{\"appId\":\"${QQ_APP_ID}\",\"clientSecret\":\"${QQ_APP_SECRET}\"}" 2>/dev/null || echo '{}')
      QQ_ACCESS_TOKEN=$(echo "$QQ_TOKEN_RESULT" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      if [ -n "$QQ_ACCESS_TOKEN" ]; then
        check "QQ app credentials are valid (access_token obtained)" 0
        # Verify gateway availability
        QQ_GW_RESULT=$(curl -s --max-time 10 "https://api.sgroup.qq.com/gateway" \
          -H "Authorization: QQBot ${QQ_ACCESS_TOKEN}" 2>/dev/null || echo '{}')
        if echo "$QQ_GW_RESULT" | grep -q '"url"'; then
          check "QQ gateway is reachable" 0
        else
          check "QQ gateway is reachable (GET /gateway failed)" 1
        fi
      else
        check "QQ app credentials are valid (getAppAccessToken failed)" 1
      fi
    else
      check "QQ app credentials configured" 1
    fi
  fi

  # --- Discord ---
  if echo "$CTI_CHANNELS" | grep -q discord; then
    DC_TOKEN=$(get_config CTI_DISCORD_BOT_TOKEN)
    if [ -n "$DC_TOKEN" ]; then
      if echo "${DC_TOKEN}" | grep -qE '^[A-Za-z0-9_-]{20,}\.'; then
        check "Discord bot token format" 0
      else
        check "Discord bot token format (does not match expected pattern)" 1
      fi
    else
      check "Discord bot token configured" 1
    fi
  fi

  # --- Weixin ---
  if echo "$CTI_CHANNELS" | grep -q weixin; then
    WX_ACCOUNTS_FILE="$CTI_HOME/data/weixin-accounts.json"
    if [ -f "$WX_ACCOUNTS_FILE" ]; then
      WX_COUNTS=$(node -e '
        const fs = require("fs");
        const file = process.argv[1];
        const accounts = JSON.parse(fs.readFileSync(file, "utf8"));
        const enabled = accounts.filter((a) => a && a.enabled && a.token).length;
        process.stdout.write(`${enabled}:${accounts.length}`);
      ' "$WX_ACCOUNTS_FILE" 2>/dev/null || echo "0:0")
      WX_ENABLED="${WX_COUNTS%%:*}"
      WX_TOTAL="${WX_COUNTS##*:}"
      if [ "${WX_ENABLED:-0}" -ge 1 ] 2>/dev/null; then
        if [ "${WX_TOTAL:-0}" -gt 1 ] 2>/dev/null; then
          check "Weixin linked account store (single-account mode; ${WX_TOTAL} records on disk, newest enabled record will be used)" 0
        else
          check "Weixin linked account store (single linked account ready)" 0
        fi
      else
        check "Weixin linked account store (found file, but no enabled linked account with token — run 'cd $SKILL_DIR && npm run weixin:login')" 1
      fi
    else
      check "Weixin linked account store (missing — run 'cd $SKILL_DIR && npm run weixin:login')" 1
    fi
  fi
fi

# --- Named Feishu+Codex external health (state/timestamps only; never render raw payloads) ---
if [ "$CTI_INSTANCE" != "default" ] \
  && [[ ",$(get_config CTI_ENABLED_CHANNELS)," == *,feishu,* ]] \
  && [ "$CTI_RUNTIME" = "codex" ]; then
  EXTERNAL_HEALTH_FILE="$CTI_HOME/runtime/external-health.json"
  if [ -f "$EXTERNAL_HEALTH_FILE" ] && [ -f "$STATUS_FILE" ]; then
  HEALTH_SUMMARY=$(node -e '
    const fs = require("fs");
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const runtime = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      const f = s && typeof s.feishu === "object" ? s.feishu : {};
      const c = s && typeof s.codex === "object" ? s.codex : {};
      const clean = (v) => typeof v === "string" && /^[0-9TZ:.+-]+$/.test(v) ? v : "";
      const started = clean(runtime.startedAt);
      const fresh = (v) => { const value = clean(v); return started && value >= started ? value : ""; };
      const connection = f.connection === "connected" && fresh(f.lastConnectedAt) ? "connected" : "unknown";
      const disconnected = fresh(f.lastDisconnectedAt);
      const success = fresh(c.lastSuccessAt);
      const error = fresh(c.lastErrorAt);
      const codexState = success && (!error || success >= error) ? "success" : (error ? "error" : "unknown");
      const pid = Number.isInteger(runtime.pid) && runtime.pid > 0 ? String(runtime.pid) : "";
      process.stdout.write([runtime.running === true ? "true" : "false", pid, connection, fresh(f.lastConnectedAt), disconnected, fresh(f.lastAcceptedInboundAt), codexState, success, error].join("|"));
    } catch { process.stdout.write("false||invalid||||||"); }
  ' "$EXTERNAL_HEALTH_FILE" "$STATUS_FILE")
  IFS='|' read -r HEALTH_RUNNING HEALTH_PID HEALTH_CONNECTION HEALTH_CONNECTED_AT HEALTH_DISCONNECTED_AT HEALTH_INBOUND_AT HEALTH_CODEX_STATE HEALTH_CODEX_SUCCESS_AT HEALTH_CODEX_ERROR_AT <<< "$HEALTH_SUMMARY"
  HEALTH_PROCESS_CURRENT=false
  if [ "$HEALTH_RUNNING" = "true" ] && [[ "$HEALTH_PID" =~ ^[0-9]+$ ]] && kill -0 "$HEALTH_PID" 2>/dev/null; then
    HEALTH_PROCESS_CURRENT=true
  fi
  if [ "$HEALTH_PROCESS_CURRENT" = "true" ] && [ "$HEALTH_CONNECTION" = "connected" ] && [ -n "$HEALTH_CONNECTED_AT" ]; then
    check "Feishu external connection connected ($HEALTH_CONNECTED_AT)" 0
    if [ -n "$HEALTH_DISCONNECTED_AT" ]; then
      echo "Feishu previous disconnect in current run ($HEALTH_DISCONNECTED_AT)"
    fi
  elif [ "$HEALTH_CONNECTION" = "connected" ] && [ -n "$HEALTH_CONNECTED_AT" ]; then
    check "Feishu external connection not current (last connected $HEALTH_CONNECTED_AT)" 1
  elif [ -n "$HEALTH_DISCONNECTED_AT" ]; then
    check "Feishu external connection disconnected ($HEALTH_DISCONNECTED_AT)" 1
  else
    check "Feishu external connection connected" 1
  fi
  if [ "$HEALTH_PROCESS_CURRENT" = "true" ] && [ -n "$HEALTH_INBOUND_AT" ]; then
    check "Feishu accepted inbound observed ($HEALTH_INBOUND_AT)" 0
  elif [ -n "$HEALTH_INBOUND_AT" ]; then
    check "Feishu accepted inbound not current (last observed $HEALTH_INBOUND_AT)" 1
  else
    check "Feishu accepted inbound observed" 1
  fi
  if [ "$HEALTH_PROCESS_CURRENT" = "true" ] && [ "$HEALTH_CODEX_STATE" = "success" ] && [ -n "$HEALTH_CODEX_SUCCESS_AT" ]; then
    check "Codex provider success observed ($HEALTH_CODEX_SUCCESS_AT)" 0
    if [ -n "$HEALTH_CODEX_ERROR_AT" ]; then
      echo "Codex previous provider error in current run ($HEALTH_CODEX_ERROR_AT)"
    fi
  elif [ "$HEALTH_CODEX_STATE" = "error" ] && [ -n "$HEALTH_CODEX_ERROR_AT" ]; then
    check "Codex provider error observed ($HEALTH_CODEX_ERROR_AT)" 1
  elif [ -n "$HEALTH_CODEX_SUCCESS_AT" ]; then
    check "Codex provider not current (last success $HEALTH_CODEX_SUCCESS_AT)" 1
  else
    check "Codex provider success observed" 1
  fi
  else
    check "External health status available" 1
  fi
fi

# --- Log directory writable ---
LOG_DIR="$CTI_HOME/logs"
if [ -d "$LOG_DIR" ] && [ -w "$LOG_DIR" ]; then
  check "Log directory is writable" 0
else
  check "Log directory is writable ($LOG_DIR)" 1
fi

# --- PID file consistency ---
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    check "PID file consistent (process $PID is running)" 0
  else
    check "PID file consistent (stale PID $PID, process not running)" 1
  fi
else
  check "PID file consistency (no PID file, OK)" 0
fi

# --- Recent errors in log ---
if [ -f "$LOG_FILE" ]; then
  ERROR_COUNT=$(tail -50 "$LOG_FILE" \
    | awk '/Starting bridge \(run_id:/ { lines = "" } { lines = lines $0 "\n" } END { printf "%s", lines }' \
    | grep -vE '\(node:[0-9]+\) \[DEP[0-9]+\] DeprecationWarning:' \
    | grep -ciE 'ERROR|Fatal' || true)
  if [ "$ERROR_COUNT" -eq 0 ]; then
    check "No recent errors in log (last 50 lines)" 0
  else
    check "No recent errors in log (found $ERROR_COUNT ERROR/Fatal lines)" 1
  fi
else
  check "Log file exists (not yet created)" 0
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Common fixes:"
  echo "  SDK cli.js missing    → cd $SKILL_DIR && npm install"
  echo "  dist/daemon.mjs stale → cd $SKILL_DIR && npm run build"
  echo "  config.env missing    → run setup wizard"
  echo "  Weixin linked account missing→ cd $SKILL_DIR && npm run weixin:login"
  echo "  Stale PID file        → run stop, then start"
  echo "  Stale lifecycle lock → follow the verified repair command printed above"
fi

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
