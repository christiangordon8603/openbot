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
    return 0
  fi
  trap 'rmdir "$LOGS/full-start.lock" 2>/dev/null || true' RETURN
  "$ROOT/scripts/start.sh" >>"$LOGS/watchdog.log" 2>&1 || true
  rmdir "$lock" 2>/dev/null || true
  trap - RETURN
}

while true; do
  # A server/container outage needs the full idempotent startup path. Host bridges and the
  # dashboard have cheaper direct restarts; rebuilding Docker for a crashed bridge made recovery
  # take minutes even though the computer stack was still healthy.
  if ! healthy "http://127.0.0.1:${SERVER_PORT:-3001}/api/capabilities"; then
    run_full_start
  fi

  if ! healthy "http://127.0.0.1:${CODEX_BRIDGE_PORT:-4203}/health"; then
    (cd "$ROOT/agent-codex" && exec env PORT="${CODEX_BRIDGE_PORT:-4203}" bun --env-file=../.env src/index.ts) >>"$LOGS/codex-bridge.log" 2>&1 </dev/null &
  fi
  if ! healthy "http://127.0.0.1:${ROUTINES_PORT:-4400}/health"; then
    (exec env ROUTINES_PORT="${ROUTINES_PORT:-4400}" ROUTINES_FILE="$ROOT/.data/monocer-routines.json" \
      bun "$ROOT/scripts/monocer-routines.ts") >>"$LOGS/routines.log" 2>&1 </dev/null &
  fi
  if ! healthy "http://127.0.0.1:${APP_PORT:-3001}/"; then
    (cd "$ROOT/app" && exec bun run dev --port "${APP_PORT:-3001}" --strictPort) >>"$LOGS/app.log" 2>&1 </dev/null &
  fi
  sleep 20
done
