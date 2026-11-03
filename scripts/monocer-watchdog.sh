#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.logs"
mkdir -p "$LOGS"
BUN_EXECUTABLE="${BUN_EXECUTABLE:-$(command -v bun || printf '%s' /opt/homebrew/bin/bun)}"

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

start_server_direct() {
  (cd "$ROOT/server" && exec env PORT="${SERVER_PORT:-3001}" APP_DIST_DIR="$ROOT/app/dist" \
    COMPUTER_SUPERVISOR_URL="${COMPUTER_SUPERVISOR_URL:-http://localhost:4500}" \
    SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN:-openbot-dev-supervisor-token}" \
    COMPUTER_TOKEN="${COMPUTER_TOKEN:-openbot-dev-computer-token}" \
    bun --env-file=../.env src/index.ts) >>"$LOGS/server.log" 2>&1 </dev/null &
}

while true; do
  # A server/container outage needs the full idempotent startup path. Host bridges and the
  # dashboard have cheaper direct restarts; rebuilding Docker for a crashed bridge made recovery
  # take minutes even though the computer stack was still healthy.
  if ! healthy "http://127.0.0.1:${SERVER_PORT:-3001}/api/capabilities"; then
    start_server_direct
    sleep 3
    if ! healthy "http://127.0.0.1:${SERVER_PORT:-3001}/api/capabilities"; then
      run_full_start
    fi
  fi

  if ! healthy "http://127.0.0.1:${CODEX_BRIDGE_PORT:-4203}/health"; then
    (cd "$ROOT/agent-codex" && nohup env PORT="${CODEX_BRIDGE_PORT:-4203}" "$BUN_EXECUTABLE" --env-file=../.env src/index.ts) >>"$LOGS/codex-bridge.log" 2>&1 </dev/null &
  fi
  if ! healthy "http://127.0.0.1:${ROUTINES_PORT:-4400}/health"; then
    (exec env ROUTINES_PORT="${ROUTINES_PORT:-4400}" ROUTINES_FILE="$ROOT/.data/monocer-routines.json" \
      nohup "$BUN_EXECUTABLE" "$ROOT/scripts/monocer-routines.ts") >>"$LOGS/routines.log" 2>&1 </dev/null &
  fi
  if ! healthy "http://127.0.0.1:${APP_PORT:-3001}/"; then
    (cd "$ROOT/app" && exec bun run dev --port "${APP_PORT:-3001}" --strictPort) >>"$LOGS/app.log" 2>&1 </dev/null &
  fi
  sleep 20
done
