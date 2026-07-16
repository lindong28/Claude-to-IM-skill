#!/usr/bin/env bash

# Canonical instance identity resolver. This file is sourced by daemon, doctor,
# and platform supervisor scripts before they derive any writable path.
CTI_INSTANCE="${CTI_INSTANCE:-default}"

if [[ ! "$CTI_INSTANCE" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Invalid CTI instance: expected ^[a-z0-9][a-z0-9-]*$" >&2
  return 64 2>/dev/null || exit 64
fi

if [ -z "${CTI_HOME:-}" ]; then
  if [ "$CTI_INSTANCE" = "default" ]; then
    CTI_HOME="$HOME/.claude-to-im"
  else
    CTI_HOME="$HOME/.claude-to-im-$CTI_INSTANCE"
  fi
fi

if [[ "$CTI_HOME" != /* ]]; then
  echo "CTI_HOME must be an absolute path." >&2
  return 64 2>/dev/null || exit 64
fi

cti_canonicalize_home() {
  local candidate="$1"
  if [ -e "$candidate" ] || [ -L "$candidate" ]; then
    realpath "$candidate"
    return
  fi
  local parent basename
  parent=$(dirname "$candidate")
  basename=$(basename "$candidate")
  [ -d "$parent" ] || return 1
  printf '%s/%s\n' "$(realpath "$parent")" "$basename"
}

CTI_HOME_ROOT="$(realpath "$HOME")"
CTI_HOME_CANONICAL="$(cti_canonicalize_home "$CTI_HOME")" || {
  echo "CTI_HOME parent must exist so its canonical path can be verified." >&2
  return 64 2>/dev/null || exit 64
}

CTI_DEFAULT_HOME_CANONICAL="$(cti_canonicalize_home "$CTI_HOME_ROOT/.claude-to-im")" || {
  echo "Could not resolve the default instance home." >&2
  return 64 2>/dev/null || exit 64
}

if [ "$CTI_HOME_CANONICAL" = "/" ] || [ "$CTI_HOME_CANONICAL" = "$CTI_HOME_ROOT" ] || \
   [[ "$CTI_HOME_ROOT" == "$CTI_HOME_CANONICAL/"* ]]; then
  echo "CTI_HOME must not be HOME, /, or an ancestor of HOME." >&2
  return 64 2>/dev/null || exit 64
fi

if [ "$CTI_INSTANCE" != "default" ] && [ "$CTI_HOME_CANONICAL" = "$CTI_DEFAULT_HOME_CANONICAL" ]; then
  echo "Named instance home must not alias the default instance home." >&2
  return 65 2>/dev/null || exit 65
fi

CTI_HOME="$CTI_HOME_CANONICAL"
CTI_INSTANCE_OWNER_FILE="$CTI_HOME/.cti-instance-owner"

if [ "$CTI_INSTANCE" != "default" ] && [ -e "$CTI_INSTANCE_OWNER_FILE" ]; then
  if [ -L "$CTI_INSTANCE_OWNER_FILE" ] || [ ! -f "$CTI_INSTANCE_OWNER_FILE" ] || \
     [ "$(cat "$CTI_INSTANCE_OWNER_FILE" 2>/dev/null)" != "$CTI_INSTANCE" ]; then
    echo "Instance ownership mismatch for canonical CTI_HOME." >&2
    return 65 2>/dev/null || exit 65
  fi
fi

unset -f cti_canonicalize_home

if [ "$CTI_INSTANCE" = "default" ]; then
  CTI_LAUNCHD_LABEL="com.claude-to-im.bridge"
else
  CTI_LAUNCHD_LABEL="com.claude-to-im.bridge.$CTI_INSTANCE"
fi

export CTI_INSTANCE CTI_HOME CTI_HOME_ROOT CTI_HOME_CANONICAL CTI_DEFAULT_HOME_CANONICAL
export CTI_INSTANCE_OWNER_FILE CTI_LAUNCHD_LABEL
