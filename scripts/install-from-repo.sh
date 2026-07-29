#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
CTI_SKILL="$REPO_DIR/claude/skills/claude-to-im"
CTI_CORE="$REPO_DIR/library/Claude-to-IM"
UPDATE_EXISTING="${UPDATE_EXISTING:-0}"
INSTALL_SERVICES="${INSTALL_SERVICES:-0}"
CTI_DEPENDENCIES_CHANGED=0
CTI_TRACKED_INSTANCES=()
CTI_TRACKED_HOMES=()
CTI_TRACKED_CONFIG_PENDING=()
CTI_TRACKED_CONFIG_HASHES=()
CTI_BUNDLE_HASH=""

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
  if [ -d "$dir/node_modules" ] && [ "$UPDATE_EXISTING" != "1" ]; then
    return
  fi
  if needs_npm_install "$dir"; then
    (cd "$dir" && npm ci)
    shasum "$dir/package-lock.json" | cut -d' ' -f1 > "$dir/node_modules/.lockfile-hash"
    CTI_DEPENDENCIES_CHANGED=1
  fi
}

materialize_tracked_instance_configs() {
  local config_root="$REPO_DIR/skill-configs/claude-to-im/instances"
  local source instance requested_home target_home target_config temp snapshot desired_hash pending
  local deployed deployed_bundle
  [ -d "$config_root" ] || return 0
  if [ ! -f "$CTI_SKILL/dist/daemon.mjs" ]; then
    echo "✗ claude-to-im daemon bundle is missing after build" >&2
    return 1
  fi
  CTI_BUNDLE_HASH="$(shasum -a 256 "$CTI_SKILL/dist/daemon.mjs" | awk '{print $1}')"

  shopt -s nullglob
  for source in "$config_root"/*/config.env; do
    instance="$(basename "$(dirname "$source")")"
    if ! [[ "$instance" =~ ^[a-z0-9][a-z0-9-]*$ ]] || [ "$instance" = "default" ]; then
      echo "✗ Invalid tracked claude-to-im instance: $instance" >&2
      shopt -u nullglob
      return 1
    fi
    if [ -L "$source" ] || [ ! -f "$source" ]; then
      echo "✗ Tracked claude-to-im config must be a regular file: $source" >&2
      shopt -u nullglob
      return 1
    fi

    requested_home="$HOME/.claude-to-im-$instance"
    if ! target_home="$({
      CTI_INSTANCE="$instance" CTI_HOME="$requested_home" \
        bash -c 'source "$1" || exit $?; printf "%s\n" "$CTI_HOME"' \
        _ "$CTI_SKILL/scripts/instance-env.sh"
    })"; then
      echo "✗ Refusing unsafe tracked claude-to-im home: $requested_home" >&2
      shopt -u nullglob
      return 1
    fi
    target_config="$target_home/config.env"
    if [ -L "$target_config" ]; then
      echo "✗ Refusing symlinked runtime config: $target_config" >&2
      shopt -u nullglob
      return 1
    fi
    install -d -m 700 \
      "$target_home" "$target_home/data" "$target_home/data/messages" \
      "$target_home/logs" "$target_home/runtime"
    chmod 700 \
      "$target_home" "$target_home/data" "$target_home/data/messages" \
      "$target_home/logs" "$target_home/runtime"
    chmod 600 "$source"

    snapshot="$(mktemp "$target_home/runtime/tracked-config-snapshot.XXXXXX")"
    if ! install -m 600 "$source" "$snapshot"; then
      rm -f "$snapshot"
      shopt -u nullglob
      return 1
    fi
    desired_hash="$(shasum -a 256 "$snapshot" | awk '{print $1}')"

    if [ ! -f "$target_config" ] || ! cmp -s "$snapshot" "$target_config"; then
      temp="$(mktemp "$target_config.tmp.XXXXXX")"
      if ! install -m 600 "$snapshot" "$temp" || ! mv -f "$temp" "$target_config"; then
        rm -f "$snapshot" "$temp"
        shopt -u nullglob
        return 1
      fi
    else
      chmod 600 "$target_config"
    fi
    rm -f "$snapshot"

    deployed="$target_home/runtime/deployed-config.sha256"
    deployed_bundle="$target_home/runtime/deployed-bundle.sha256"
    pending=0
    if [ ! -f "$deployed" ] || [ "$(cat "$deployed" 2>/dev/null)" != "$desired_hash" ] || \
       [ ! -f "$deployed_bundle" ] || [ "$(cat "$deployed_bundle" 2>/dev/null)" != "$CTI_BUNDLE_HASH" ]; then
      pending=1
    fi

    CTI_TRACKED_INSTANCES+=("$instance")
    CTI_TRACKED_HOMES+=("$target_home")
    CTI_TRACKED_CONFIG_PENDING+=("$pending")
    CTI_TRACKED_CONFIG_HASHES+=("$desired_hash")
  done
  shopt -u nullglob
}

is_tracked_instance() {
  local candidate="$1"
  local tracked
  for tracked in "${CTI_TRACKED_INSTANCES[@]-}"; do
    [ "$candidate" != "$tracked" ] || return 0
  done
  return 1
}

write_private_state() {
  local path="$1"
  local value="$2"
  local temp
  temp="$(mktemp "$path.tmp.XXXXXX")"
  printf '%s\n' "$value" > "$temp"
  chmod 600 "$temp"
  mv -f "$temp" "$path"
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

  local plist label instance cti_home resolved_home restarted=0
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
    if is_tracked_instance "$instance"; then
      continue
    fi
    if [ "$instance" = "default" ] && [ "${CTI_MANAGE_DEFAULT:-0}" != "1" ]; then
      echo "→ skipping default claude-to-im instance (set CTI_MANAGE_DEFAULT=1 to converge it)"
      continue
    fi

    cti_home=""
    if command -v plutil >/dev/null 2>&1; then
      cti_home="$(plutil -extract EnvironmentVariables.CTI_HOME raw -o - "$plist" 2>/dev/null || true)"
    fi
    if [ -n "$cti_home" ]; then
      resolved_home="$cti_home"
    elif [ "$instance" = "default" ]; then
      resolved_home="$HOME/.claude-to-im"
    else
      resolved_home="$HOME/.claude-to-im-$instance"
    fi
    if [ ! -f "$resolved_home/config.env" ]; then
      echo "→ skipping claude-to-im instance with missing config: $instance"
      continue
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

converge_tracked_instance_services() {
  local bundle_changed="$1"
  local index instance cti_home config_pending desired_hash label plist
  local deployed deployed_bundle pending_marker managed should_converge
  [ "${#CTI_TRACKED_INSTANCES[@]}" -gt 0 ] || return 0

  if [ "$(uname -s)" != "Darwin" ] || ! command -v launchctl >/dev/null 2>&1; then
    echo "→ tracked claude-to-im configs installed; automatic service deployment requires launchd"
    return
  fi

  for ((index = 0; index < ${#CTI_TRACKED_INSTANCES[@]}; index++)); do
    instance="${CTI_TRACKED_INSTANCES[$index]}"
    cti_home="${CTI_TRACKED_HOMES[$index]}"
    config_pending="${CTI_TRACKED_CONFIG_PENDING[$index]}"
    desired_hash="${CTI_TRACKED_CONFIG_HASHES[$index]}"
    label="com.claude-to-im.bridge.$instance"
    plist="$HOME/Library/LaunchAgents/$label.plist"
    deployed="$cti_home/runtime/deployed-config.sha256"
    deployed_bundle="$cti_home/runtime/deployed-bundle.sha256"
    pending_marker="$cti_home/runtime/config-convergence-pending"
    managed=0
    should_converge=0

    if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
      managed=1
      if [ "$bundle_changed" = "1" ] || [ "$config_pending" = "1" ] || [ -f "$pending_marker" ]; then
        should_converge=1
      fi
    elif [ -f "$pending_marker" ]; then
      should_converge=1
    elif [ -e "$plist" ]; then
      echo "→ preserving stopped claude-to-im instance: $instance"
      continue
    elif [ "$INSTALL_SERVICES" = "1" ]; then
      should_converge=1
    else
      # Service opt-in (§3.6): a never-installed instance deploys only on
      # explicit opt-in; its config stays materialized for a later opt-in run.
      echo "→ optional claude-to-im instance not installed: $instance (enable with INSTALL_SERVICES=1)"
      continue
    fi

    [ "$should_converge" = "1" ] || continue
    write_private_state "$pending_marker" "$desired_hash"
    if [ "$managed" = "1" ]; then
      echo "→ converging tracked claude-to-im instance: $instance"
      CTI_INSTANCE="$instance" CTI_HOME="$cti_home" bash "$CTI_SKILL/scripts/daemon.sh" stop
    else
      echo "→ deploying tracked claude-to-im instance: $instance"
    fi
    CTI_INSTANCE="$instance" CTI_HOME="$cti_home" bash "$CTI_SKILL/scripts/daemon.sh" start
    write_private_state "$deployed" "$desired_hash"
    write_private_state "$deployed_bundle" "$CTI_BUNDLE_HASH"
    rm -f "$pending_marker"
  done
}

run_npm_install "$CTI_CORE"
run_npm_install "$CTI_SKILL"

bundle_rebuilt=0
if daemon_bundle_is_stale; then
  (cd "$CTI_SKILL" && npm run build)
  bundle_rebuilt=1
fi
materialize_tracked_instance_configs
if [ "$CTI_DEPENDENCIES_CHANGED" = "1" ] || [ "$bundle_rebuilt" = "1" ]; then
  restart_managed_instances
  bundle_changed=1
else
  bundle_changed=0
fi
converge_tracked_instance_services "$bundle_changed"
