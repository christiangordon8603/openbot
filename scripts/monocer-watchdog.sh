#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.logs"
mkdir -p "$LOGS"

healthy() {
  curl -fsS --max-time 3 "$1" >/dev/null 2>&1
}

run_full_start() {
  local lock="$LOGS/full-start.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    local owner=""
    if [ -f "$lock/pid" ]; then
      owner="$(<"$lock/pid")"
    fi
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      return 0
    fi
    unlink "$lock/pid" 2>/dev/null || true
    rmdir "$lock" 2>/dev/null || return 0
    mkdir "$lock" 2>/dev/null || return 0
  fi
  # Do not hold the watchdog inside Docker startup. A full recovery can take a while, and the
  # bridge/routines checks still need to run while it is in progress. The lock remains the single
  # owner of this recovery; its pid is the background helper, not the long-lived watchdog.
  (
    "$ROOT/scripts/start.sh" >>"$LOGS/watchdog.log" 2>&1 || true
    unlink "$lock/pid" 2>/dev/null || true
    rmdir "$lock" 2>/dev/null || true
  ) &
  printf '%s\n' "$!" >"$lock/pid"
}

while true; do
  # A server/container outage needs the full idempotent startup path. Host bridges and the
  # dashboard have cheaper direct restarts; rebuilding Docker for a crashed bridge made recovery
  # take minutes even though the computer stack was still healthy.
  if ! healthy "http://127.0.0.1:${SERVER_PORT:-3001}/api/capabilities"; then
    launchctl kickstart -k "gui/$(id -u)/com.monocer.openbot.server" 2>/dev/null || true
    sleep 3
    if ! healthy "http://127.0.0.1:${SERVER_PORT:-3001}/api/capabilities"; then
      run_full_start
    fi
  fi

  # The Codex bridge and routine runner have their own launchd jobs. Keeping their process
  # ownership out of this long-lived Bash loop is important on macOS: a watchdog can remain
  # healthy while its fork table is unable to spawn another Bun child.
  if ! healthy "http://127.0.0.1:${APP_PORT:-3010}/"; then
    launchctl kickstart -k "gui/$(id -u)/com.monocer.openbot.app" 2>/dev/null || true
  fi
  sleep 20
done
