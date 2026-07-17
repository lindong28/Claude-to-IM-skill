#!/usr/bin/env bash
# macOS supervisor — launchd-based process management.
# Sourced by daemon.sh; expects resolved identity plus runtime paths.

if [ -z "${CTI_LAUNCHD_LABEL:-}" ]; then
  # shellcheck source=instance-env.sh
  source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/instance-env.sh"
fi

LAUNCHD_LABEL="$CTI_LAUNCHD_LABEL"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$LAUNCHD_LABEL.plist"

# ── launchd helpers ──

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

proxy_has_userinfo() {
  local value="$1"
  local authority
  case "$value" in
    *://*) authority="${value#*://}" ;;
    *) authority="$value" ;;
  esac
  authority="${authority%%/*}"
  [[ "$authority" == *@* ]]
}

# Collect env vars that should be forwarded into the plist.
# We honour clean_env() logic by reading *after* clean_env runs.
build_env_dict() {
  local indent="            "
  local dict=""

  # Always forward basics + proxy
  for var in HOME PATH USER SHELL LANG TMPDIR HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    local val="${!var:-}"
    [ -z "$val" ] && continue
    case "$var" in
      HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy)
        if proxy_has_userinfo "$val"; then
          echo "Authenticated proxy URLs are not supported in LaunchAgent environments." >&2
          return 64
        fi
        ;;
    esac
    val=$(xml_escape "$val")
    dict+="${indent}<key>${var}</key>"
    dict+=$'\n'
    dict+="${indent}<string>${val}</string>"
    dict+=$'\n'
  done

  # Identity and non-sensitive process controls only. Credentials and channel
  # allowlists are loaded by the process from the private config.env.
  for var in CTI_HOME CTI_INSTANCE; do
    local val="${!var:-}"
    [ -z "$val" ] && continue
    val=$(xml_escape "$val")
    dict+="${indent}<key>${var}</key>"
    dict+=$'\n'
    dict+="${indent}<string>${val}</string>"
    dict+=$'\n'
  done

  printf '%s' "$dict"
}

generate_plist() {
  local node_path
  node_path=$(command -v node)

  mkdir -p "$PLIST_DIR"
  local env_dict
  env_dict=$(build_env_dict)
  local node_path_xml label_xml skill_dir_xml log_file_xml
  node_path_xml=$(xml_escape "$node_path")
  label_xml=$(xml_escape "$LAUNCHD_LABEL")
  skill_dir_xml=$(xml_escape "$SKILL_DIR")
  log_file_xml=$(xml_escape "$LOG_FILE")

  # Build optional Node.js flags
  local node_flags=""
  # Enable --use-env-proxy when proxy env vars are set and Node supports it
  if [ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}" ] && \
     "$node_path" --use-env-proxy -e "" 2>/dev/null; then
    node_flags="--use-env-proxy"
  fi

  cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label_xml}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${node_path_xml}</string>
${node_flags:+        <string>${node_flags}</string>
}        <string>${skill_dir_xml}/dist/daemon.mjs</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${skill_dir_xml}</string>

    <key>StandardOutPath</key>
    <string>${log_file_xml}</string>
    <key>StandardErrorPath</key>
    <string>${log_file_xml}</string>

    <key>Umask</key>
    <integer>63</integer>

    <key>RunAtLoad</key>
    <false/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>EnvironmentVariables</key>
    <dict>
${env_dict}    </dict>
</dict>
</plist>
PLIST
  chmod 600 "$PLIST_FILE"
}

# ── Public interface (called by daemon.sh) ──

supervisor_bootout_selected() {
  local output
  if output=$(launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>&1); then
    return 0
  fi
  if echo "$output" | grep -qiE 'no such process|could not find service|service not found'; then
    return 0
  fi
  echo "Failed to stop selected LaunchAgent $LAUNCHD_LABEL." >&2
  return 1
}

supervisor_assert_selected_stopped() {
  local _
  for _ in $(seq 1 20); do
    if ! supervisor_is_managed && ! supervisor_is_running; then
      return 0
    fi
    sleep 0.1
  done
  echo "Selected LaunchAgent $LAUNCHD_LABEL is still managed or running." >&2
  return 1
}

supervisor_start() {
  supervisor_bootout_selected
  supervisor_assert_selected_stopped
  generate_plist
  launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
}

supervisor_stop() {
  supervisor_bootout_selected
  supervisor_assert_selected_stopped
  rm -f "$PID_FILE"
}

supervisor_uninstall() {
  supervisor_stop
  supervisor_assert_selected_stopped
  rm -f "$PLIST_FILE"
}

supervisor_is_managed() {
  launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" &>/dev/null
}

supervisor_status_extra() {
  if supervisor_is_managed; then
    echo "Bridge is registered with launchd ($LAUNCHD_LABEL)"
    # Extract PID from launchctl as the authoritative source
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      echo "launchd reports PID: $lc_pid"
    fi
  fi
}

# Override: on macOS, check launchctl first, then fall back to PID file
supervisor_is_running() {
  # Primary: launchctl knows the process
  if supervisor_is_managed; then
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      return 0
    fi
  fi
  # Fallback: PID file
  local pid
  pid=$(read_pid)
  pid_alive "$pid"
}
