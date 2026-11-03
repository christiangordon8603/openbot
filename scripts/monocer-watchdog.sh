#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.logs"
mkdir -p "$LOGS"

healthy() {
  curl -fsS --max-time 3 "$1" >/dev/null 2>&1
}

while true; do
  if ! healthy "http://127.0.0.1:${CODEX_BRIDGE_PORT:-4203}/health" \
    || ! healthy "http://127.0.0.1:${ROUTINES_PORT:-4400}/health" \
    || ! healthy "http://127.0.0.1:${APP_PORT:-3001}/"; then
    "$ROOT/scripts/start.sh" >>"$LOGS/watchdog.log" 2>&1 || true
  fi
  sleep 20
done
