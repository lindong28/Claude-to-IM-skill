#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
CTI_SKILL="$REPO_DIR/claude/skills/claude-to-im"
CTI_CORE="$REPO_DIR/library/Claude-to-IM"
CTI_PATCH="$REPO_DIR/library/claude-to-im.patch"
UPDATE_EXISTING="${UPDATE_EXISTING:-0}"
CTI_DEPENDENCIES_CHANGED=0
CTI_PATCH_CHANGED=0

needs_npm_install() {
  local dir="$1"
  local stamp="$dir/node_modules/.lockfile-hash"
  local current
  current="$(shasum "$dir/package-lock.json" 2>/dev/null | cut -d' ' -f1)"
  [ -z "$current" ] && return 0
  [ ! -f "$stamp" ] && return 0
  [ "$current" != "$(cat "$stamp" 2>/dev/null)" ]
}

run_npm_install() {
  local dir="$1"
  local force="${2:-0}"
  if [ -d "$dir/node_modules" ] && [ "$UPDATE_EXISTING" != "1" ] && [ "$force" != "1" ]; then
    return
  fi
  if needs_npm_install "$dir"; then
    (cd "$dir" && npm ci)
    shasum "$dir/package-lock.json" | cut -d' ' -f1 > "$dir/node_modules/.lockfile-hash"
    CTI_DEPENDENCIES_CHANGED=1
  fi
}

apply_component_patch() {
  local target base_hash desired_hash current_hash
  local absent_targets=""
  local drifted_targets=""
  local patch_targets="package.json package-lock.json src/main.ts"

  for target in $patch_targets; do
    read -r base_hash desired_hash < <(
      awk -v marker="diff --git a/$target b/$target" '
        $0 == marker { found = 1; next }
        found && /^index / {
          split($2, hashes, "\\.\\.")
          print hashes[1], hashes[2]
          exit
        }
      ' "$CTI_PATCH"
    )
    [ -n "$base_hash" ] && [ -n "$desired_hash" ] || {
      echo "✗ CTI patch metadata missing for $target" >&2
      return 1
    }
    current_hash="$(git -C "$CTI_SKILL" hash-object "$target")"
    case "$current_hash" in
      "$desired_hash"*) ;;
      "$base_hash"*) absent_targets="$absent_targets $target" ;;
      *) drifted_targets="$drifted_targets $target" ;;
    esac
  done

  if [ -n "$drifted_targets" ]; then
    if [ "$UPDATE_EXISTING" = "1" ]; then
      echo "✗ CTI patch targets drifted:$drifted_targets" >&2
      echo "  Refresh library/claude-to-im.patch against the current submodule before updating." >&2
      return 1
    fi
    echo "→ CTI patch targets drifted; skipping patch (UPDATE_EXISTING=0):$drifted_targets"
    return
  fi

  if [ -n "$absent_targets" ]; then
    local -a apply_args=()
    for target in $absent_targets; do
      apply_args+=("--include=$target")
    done
    git -C "$CTI_SKILL" apply "${apply_args[@]}" "$CTI_PATCH"
    CTI_PATCH_CHANGED=1
  fi
}

daemon_bundle_is_stale() {
  local bundle="$CTI_SKILL/dist/daemon.mjs"
  [ -f "$bundle" ] || return 0
  [ -z "$(find "$CTI_SKILL/src" -name '*.ts' -newer "$bundle" -print -quit 2>/dev/null)" ] || return 0
  if [ -d "$CTI_SKILL/node_modules/claude-to-im/src" ]; then
    [ -z "$(find "$CTI_SKILL/node_modules/claude-to-im/src" -name '*.ts' -newer "$bundle" -print -quit 2>/dev/null)" ] || return 0
  fi
  return 1
}

restart_managed_instances() {
  if [ "$(uname -s)" != "Darwin" ] || ! command -v launchctl >/dev/null 2>&1; then
    echo "→ claude-to-im bundle rebuilt; automatic service restart is only available for launchd"
    return
  fi

  local plist label instance cti_home restarted=0
  shopt -s nullglob
  for plist in "$HOME"/Library/LaunchAgents/com.claude-to-im.bridge*.plist; do
    label="$(basename "$plist" .plist)"
    case "$label" in
      com.claude-to-im.bridge) instance="default" ;;
      com.claude-to-im.bridge.*) instance="${label#com.claude-to-im.bridge.}" ;;
      *) continue ;;
    esac
    [[ "$instance" =~ ^[a-z0-9][a-z0-9-]*$ ]] || continue
    launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || continue

    cti_home=""
    if command -v plutil >/dev/null 2>&1; then
      cti_home="$(plutil -extract EnvironmentVariables.CTI_HOME raw -o - "$plist" 2>/dev/null || true)"
    fi
    echo "→ restarting claude-to-im instance: $instance"
    if [ -n "$cti_home" ]; then
      CTI_INSTANCE="$instance" CTI_HOME="$cti_home" bash "$CTI_SKILL/scripts/daemon.sh" stop
      CTI_INSTANCE="$instance" CTI_HOME="$cti_home" bash "$CTI_SKILL/scripts/daemon.sh" start
    else
      CTI_INSTANCE="$instance" bash "$CTI_SKILL/scripts/daemon.sh" stop
      CTI_INSTANCE="$instance" bash "$CTI_SKILL/scripts/daemon.sh" start
    fi
    restarted=1
  done
  shopt -u nullglob

  [ "$restarted" = "1" ] || echo "→ claude-to-im bundle rebuilt; no managed launchd instances found"
}

apply_component_patch

run_npm_install "$CTI_CORE"
run_npm_install "$CTI_SKILL" "$CTI_PATCH_CHANGED"

bundle_rebuilt=0
if daemon_bundle_is_stale; then
  (cd "$CTI_SKILL" && npm run build)
  bundle_rebuilt=1
fi
if [ "$CTI_PATCH_CHANGED" = "1" ] || [ "$CTI_DEPENDENCIES_CHANGED" = "1" ] || [ "$bundle_rebuilt" = "1" ]; then
  restart_managed_instances
fi
