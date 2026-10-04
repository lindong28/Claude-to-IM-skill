#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALLER="$SCRIPT_DIR/install-from-repo.sh"

fail() {
  echo "not ok - $1" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$file" || fail "$file does not contain: $expected"
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    fail "$file still contains component logic: $unexpected"
  fi
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

test_root_is_orchestration_only() {
  local root_installer="$REPO_ROOT/install.sh"

  assert_contains "$root_installer" 'claude-to-im/scripts/install-from-repo.sh'
  assert_contains "$root_installer" 'skill-configs/*/instances/*/config.env'
  assert_not_contains "$root_installer" 'claude_to_im_needs_restart()'
  assert_not_contains "$root_installer" 'restart_claude_to_im_bridge_if_needed()'
  assert_not_contains "$root_installer" 'CTI_PATCH='
  assert_not_contains "$root_installer" 'run_npm_install "$REPO_DIR/library/Claude-to-IM"'
}

test_component_installer_converges_dependencies_and_daemon() {
  local sandbox fake_repo stub_bin log
  sandbox="$(mktemp -d)"
  trap 'rm -rf "$sandbox"' RETURN
  fake_repo="$sandbox/repo"
  stub_bin="$sandbox/bin"
  log="$sandbox/calls.log"

  mkdir -p \
    "$fake_repo/claude-to-im/scripts" \
    "$fake_repo/claude-to-im/src" \
    "$fake_repo/library/Claude-to-IM" \
    "$sandbox/home/Library/LaunchAgents" \
    "$sandbox/home/.claude-to-im-quant-lab" \
    "$stub_bin"
  printf '{"lockfileVersion":3}\n' > "$fake_repo/library/Claude-to-IM/package-lock.json"
  printf '{"lockfileVersion":3}\n' > "$fake_repo/claude-to-im/package-lock.json"
  : > "$sandbox/home/Library/LaunchAgents/com.claude-to-im.bridge.quant-lab.plist"
  : > "$sandbox/home/Library/LaunchAgents/com.claude-to-im.bridge.plist"
  printf 'CTI_RUNTIME=codex\n' > "$sandbox/home/.claude-to-im-quant-lab/config.env"
  printf 'export CTI_TEST_LOG=%q\nprintf "daemon %%s %%s %%s\\n" "${CTI_INSTANCE:-}" "${CTI_HOME:-}" "$1" >> "$CTI_TEST_LOG"\n' "$log" \
    > "$fake_repo/claude-to-im/scripts/daemon.sh"

  cat > "$stub_bin/npm" <<'EOF'
#!/usr/bin/env bash
printf 'npm %s %s\n' "$PWD" "$*" >> "$CTI_TEST_LOG"
mkdir -p node_modules
if [ "${1:-}" = "run" ] && [ "${2:-}" = "build" ]; then
  mkdir -p dist
  : > dist/daemon.mjs
fi
EOF
  cat > "$stub_bin/launchctl" <<'EOF'
#!/usr/bin/env bash
printf 'launchctl %s\n' "$*" >> "$CTI_TEST_LOG"
exit 0
EOF
  cat > "$stub_bin/plutil" <<'EOF'
#!/usr/bin/env bash
case "$2" in
  WorkingDirectory) echo "${CTI_TEST_RUNTIME_ROOT:-old-runtime}" ; exit ;;
  ProgramArguments) echo 2 ; exit ;;
  ProgramArguments.1) echo "${CTI_TEST_RUNTIME_ROOT:-old-runtime}/dist/daemon.mjs" ; exit ;;
esac
case "$*" in
  *com.claude-to-im.bridge.quant-lab.plist*) echo "$HOME/.claude-to-im-quant-lab" ;;
  *) exit 1 ;;
esac
EOF
  cat > "$stub_bin/uname" <<'EOF'
#!/usr/bin/env bash
echo Darwin
EOF
  chmod +x "$stub_bin"/* "$fake_repo/claude-to-im/scripts/daemon.sh"

  CTI_TEST_LOG="$log" HOME="$sandbox/home" REPO_DIR="$fake_repo" UPDATE_EXISTING=1 PATH="$stub_bin:$PATH" \
    bash "$INSTALLER"

  assert_contains "$log" "npm $fake_repo/library/Claude-to-IM ci"
  assert_contains "$log" "npm $fake_repo/claude-to-im ci"
  assert_contains "$log" "daemon quant-lab $sandbox/home/.claude-to-im-quant-lab stop"
  assert_contains "$log" "daemon quant-lab $sandbox/home/.claude-to-im-quant-lab start"
  if grep -Fq -- 'daemon default ' "$log"; then
    fail "component installer stopped a managed instance whose config is missing"
  fi

  : > "$log"
  rm -rf "$fake_repo/library/Claude-to-IM/node_modules" "$fake_repo/claude-to-im/node_modules"
  : > "$fake_repo/claude-to-im/src/input.ts"
  touch "$fake_repo/claude-to-im/dist/daemon.mjs"
  CTI_TEST_LOG="$log" HOME="$sandbox/home" REPO_DIR="$fake_repo" \
    UPDATE_EXISTING=1 PATH="$stub_bin:$PATH" bash "$INSTALLER"

  assert_contains "$log" "npm $fake_repo/library/Claude-to-IM ci"
  assert_contains "$log" "npm $fake_repo/claude-to-im ci"
  assert_contains "$log" "daemon quant-lab $sandbox/home/.claude-to-im-quant-lab stop"
  assert_contains "$log" "daemon quant-lab $sandbox/home/.claude-to-im-quant-lab start"

  : > "$log"
  mkdir -p "$sandbox/home/.claude-to-im"
  printf 'CTI_RUNTIME=claude\n' > "$sandbox/home/.claude-to-im/config.env"
  CTI_TEST_LOG="$log" HOME="$sandbox/home" REPO_DIR="$fake_repo" \
    CTI_MANAGE_DEFAULT=1 PATH="$stub_bin:$PATH" bash "$INSTALLER"
  assert_contains "$log" "daemon default  stop"
  assert_contains "$log" "daemon default  start"
  assert_contains "$log" "daemon quant-lab $sandbox/home/.claude-to-im-quant-lab start"
  assert_not_contains "$log" "npm "

  : > "$log"
  CTI_TEST_LOG="$log" CTI_TEST_RUNTIME_ROOT="$fake_repo/claude-to-im" \
    HOME="$sandbox/home" REPO_DIR="$fake_repo" CTI_MANAGE_DEFAULT=1 \
    PATH="$stub_bin:$PATH" bash "$INSTALLER"
  assert_not_contains "$log" "daemon "
}

test_tracked_named_config_materializes_and_converges_service() {
  local sandbox fake_repo stub_bin log service_state target_config marker pending default_config canonical_home
  sandbox="$(mktemp -d)"
  trap 'rm -rf "$sandbox"' RETURN
  fake_repo="$sandbox/repo"
  stub_bin="$sandbox/bin"
  log="$sandbox/calls.log"
  service_state="$sandbox/service-managed"
  target_config="$sandbox/home/.claude-to-im-quant-lab/config.env"
  marker="$sandbox/home/.claude-to-im-quant-lab/runtime/deployed-config.sha256"
  pending="$sandbox/home/.claude-to-im-quant-lab/runtime/config-convergence-pending"
  default_config="$sandbox/home/.claude-to-im/config.env"

  mkdir -p \
    "$fake_repo/claude-to-im/scripts" \
    "$fake_repo/claude-to-im/src" \
    "$fake_repo/claude-to-im/dist" \
    "$fake_repo/library/Claude-to-IM/node_modules" \
    "$fake_repo/claude-to-im/node_modules" \
    "$fake_repo/skill-configs/claude-to-im/instances/quant-lab" \
    "$sandbox/home/Library/LaunchAgents" \
    "$stub_bin"
  canonical_home="$(realpath "$sandbox/home")/.claude-to-im-quant-lab"
  printf '{"lockfileVersion":3}\n' > "$fake_repo/library/Claude-to-IM/package-lock.json"
  printf '{"lockfileVersion":3}\n' > "$fake_repo/claude-to-im/package-lock.json"
  shasum "$fake_repo/library/Claude-to-IM/package-lock.json" | cut -d' ' -f1 \
    > "$fake_repo/library/Claude-to-IM/node_modules/.lockfile-hash"
  shasum "$fake_repo/claude-to-im/package-lock.json" | cut -d' ' -f1 \
    > "$fake_repo/claude-to-im/node_modules/.lockfile-hash"
  : > "$fake_repo/claude-to-im/dist/daemon.mjs"
  cp "$SKILL_DIR/scripts/instance-env.sh" \
    "$fake_repo/claude-to-im/scripts/instance-env.sh"
  printf 'CTI_RUNTIME=codex\nCTI_ENABLED_CHANNELS=feishu\n' \
    > "$fake_repo/skill-configs/claude-to-im/instances/quant-lab/config.env"
  cat > "$fake_repo/claude-to-im/scripts/daemon.sh" <<'EOF'
#!/usr/bin/env bash
printf 'daemon %s %s %s\n' "${CTI_INSTANCE:-}" "${CTI_HOME:-}" "$1" >> "$CTI_TEST_LOG"
if [ "$1" = stop ]; then
  rm -f "$CTI_TEST_SERVICE_STATE"
elif [ "$1" = start ]; then
  [ "${CTI_TEST_FAIL_START:-0}" != "1" ] || exit 70
  : > "$CTI_TEST_SERVICE_STATE"
  mkdir -p "$HOME/Library/LaunchAgents"
  (cd "$(dirname "$0")/.." && pwd) > "$HOME/Library/LaunchAgents/com.claude-to-im.bridge.${CTI_INSTANCE}.plist"
fi
EOF

  cat > "$stub_bin/plutil" <<'EOF'
#!/usr/bin/env bash
root="$(cat "${@: -1}")"
case "$2" in
  WorkingDirectory) echo "$root" ;;
  ProgramArguments) echo 2 ;;
  ProgramArguments.1) echo "$root/dist/daemon.mjs" ;;
  *) exit 1 ;;
esac
EOF
  cat > "$stub_bin/launchctl" <<'EOF'
#!/usr/bin/env bash
[ -e "$CTI_TEST_SERVICE_STATE" ]
EOF
  cat > "$stub_bin/npm" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = run ] && [ "${2:-}" = build ]; then
  [ "${CTI_TEST_FAIL_BUILD:-0}" != "1" ] || exit 71
  mkdir -p dist
  : > dist/daemon.mjs
fi
EOF
  cat > "$stub_bin/install" <<'EOF'
#!/usr/bin/env bash
previous=""
last=""
for argument in "$@"; do
  previous="$last"
  last="$argument"
done
/usr/bin/install "$@"
if [ "${CTI_TEST_MUTATE_CONFIG_AFTER_COPY:-0}" = "1" ] && \
   [ "$previous" = "$CTI_TEST_CANONICAL_CONFIG" ] && \
   [ ! -e "$CTI_TEST_CONFIG_MUTATED" ]; then
  printf 'CTI_SNAPSHOT_RACE=mutated\n' >> "$CTI_TEST_CANONICAL_CONFIG"
  : > "$CTI_TEST_CONFIG_MUTATED"
fi
EOF
  cat > "$stub_bin/uname" <<'EOF'
#!/usr/bin/env bash
echo Darwin
EOF
  chmod +x "$stub_bin"/* "$fake_repo/claude-to-im/scripts/daemon.sh"

  mkdir -p "$sandbox/home/.claude-to-im"
  printf 'DEFAULT_SENTINEL=unchanged\n' > "$default_config"
  ln -s "$sandbox/home/.claude-to-im" "$sandbox/home/.claude-to-im-quant-lab"
  if CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" HOME="$sandbox/home" \
    REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" bash "$INSTALLER" >/dev/null 2>&1; then
    fail "tracked named config accepted a CTI_HOME alias to the default instance"
  fi
  [ "$(cat "$default_config")" = 'DEFAULT_SENTINEL=unchanged' ] \
    || fail "default config was overwritten before named-home identity validation"
  rm "$sandbox/home/.claude-to-im-quant-lab"

  rm "$fake_repo/claude-to-im/dist/daemon.mjs"
  if CTI_TEST_FAIL_BUILD=1 CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" \
    HOME="$sandbox/home" REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" \
    bash "$INSTALLER" >/dev/null 2>&1; then
    fail "installer accepted a failed bundle build"
  fi
  [ ! -e "$target_config" ] \
    || fail "tracked config was materialized before the bundle build succeeded"
  : > "$fake_repo/claude-to-im/dist/daemon.mjs"

  # §3.6 opt-in: without INSTALL_SERVICES=1 a never-installed instance is
  # materialized for later runs but not deployed.
  : > "$log"
  CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" HOME="$sandbox/home" \
    REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" bash "$INSTALLER"
  [ -f "$target_config" ] || fail "opt-out run did not materialize the tracked config"
  [ ! -e "$marker" ] || fail "opt-out run recorded a deployed marker"
  [ ! -e "$sandbox/home/Library/LaunchAgents/com.claude-to-im.bridge.quant-lab.plist" ] \
    || fail "opt-out run deployed the launchd instance"
  [ ! -s "$log" ] || fail "opt-out run invoked the instance daemon"

  CTI_TEST_MUTATE_CONFIG_AFTER_COPY=1 \
    CTI_TEST_CANONICAL_CONFIG="$fake_repo/skill-configs/claude-to-im/instances/quant-lab/config.env" \
    CTI_TEST_CONFIG_MUTATED="$sandbox/config-mutated" \
    CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" HOME="$sandbox/home" \
    REPO_DIR="$fake_repo" INSTALL_SERVICES=1 PATH="$stub_bin:$PATH" bash "$INSTALLER"

  [ -e "$sandbox/config-mutated" ] || fail "config snapshot race fixture did not mutate the canonical source"
  [ -f "$target_config" ] || fail "tracked named config was not materialized"
  [ "$(cat "$marker")" = "$(shasum -a 256 "$target_config" | awk '{print $1}')" ] \
    || fail "deployed marker does not identify the exact runtime config snapshot"
  [ "$(stat_mode "$sandbox/home/.claude-to-im-quant-lab")" = "0700" ] \
    || fail "named instance home is not mode 700"
  [ "$(stat_mode "$target_config")" = "0600" ] \
    || fail "materialized named config is not mode 600"
  [ -s "$marker" ] || fail "successful deployment did not record the deployed config hash"
  [ ! -e "$pending" ] || fail "successful deployment left a convergence-pending marker"
  assert_contains "$log" "daemon quant-lab $canonical_home start"

  : > "$log"
  CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" HOME="$sandbox/home" \
    REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" bash "$INSTALLER"
  cmp -s "$fake_repo/skill-configs/claude-to-im/instances/quant-lab/config.env" "$target_config" \
    || fail "next install did not converge a canonical config changed during snapshotting"
  assert_contains "$log" "daemon quant-lab $canonical_home stop"
  assert_contains "$log" "daemon quant-lab $canonical_home start"

  : > "$log"
  CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" HOME="$sandbox/home" \
    REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" bash "$INSTALLER"
  [ ! -s "$log" ] || fail "unchanged tracked config restarted the managed instance"

  # Same bundle/config, different runtime location must still converge.
  printf 'old-runtime\n' > "$sandbox/home/Library/LaunchAgents/com.claude-to-im.bridge.quant-lab.plist"
  CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" HOME="$sandbox/home" \
    REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" bash "$INSTALLER"
  assert_contains "$log" "daemon quant-lab $canonical_home stop"
  assert_contains "$log" "daemon quant-lab $canonical_home start"
  : > "$log"
  CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" HOME="$sandbox/home" \
    REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" bash "$INSTALLER"
  [ ! -s "$log" ] || fail "converged runtime path restarted again"

  printf 'CTI_DEFAULT_MODE=code\n' \
    >> "$fake_repo/skill-configs/claude-to-im/instances/quant-lab/config.env"
  CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" HOME="$sandbox/home" \
    REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" bash "$INSTALLER"
  assert_contains "$log" "daemon quant-lab $canonical_home stop"
  assert_contains "$log" "daemon quant-lab $canonical_home start"

  : > "$log"
  printf 'new bundle snapshot\n' >> "$fake_repo/claude-to-im/dist/daemon.mjs"
  CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" HOME="$sandbox/home" \
    REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" bash "$INSTALLER"
  assert_contains "$log" "daemon quant-lab $canonical_home stop"
  assert_contains "$log" "daemon quant-lab $canonical_home start"

  : > "$log"
  rm -f "$service_state"
  CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" HOME="$sandbox/home" \
    REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" bash "$INSTALLER"
  [ ! -s "$log" ] || fail "installer resurrected a deliberately stopped tracked instance"

  printf 'CTI_CODEX_WORKDIR=~/research/quant-lab\n' \
    >> "$fake_repo/skill-configs/claude-to-im/instances/quant-lab/config.env"
  CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" HOME="$sandbox/home" \
    REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" bash "$INSTALLER"
  [ ! -s "$log" ] || fail "config update resurrected a deliberately stopped tracked instance"

  : > "$service_state"
  : > "$log"
  if CTI_TEST_FAIL_START=1 CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" \
    HOME="$sandbox/home" REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" \
    bash "$INSTALLER" >/dev/null 2>&1; then
    fail "installer accepted a failed tracked-instance restart"
  fi
  [ -s "$pending" ] || fail "failed restart did not preserve convergence intent"

  : > "$log"
  CTI_TEST_LOG="$log" CTI_TEST_SERVICE_STATE="$service_state" HOME="$sandbox/home" \
    REPO_DIR="$fake_repo" PATH="$stub_bin:$PATH" bash "$INSTALLER"
  assert_contains "$log" "daemon quant-lab $canonical_home start"
  [ ! -e "$pending" ] || fail "successful retry did not clear convergence intent"
}


test_root_is_orchestration_only
test_component_installer_converges_dependencies_and_daemon
test_tracked_named_config_materializes_and_converges_service
echo "ok - claude-to-im repository installer boundary"
