#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
unset XPC_SERVICE_NAME
cd "$ROOT/server"

exec env \
  PORT="${SERVER_PORT:-3001}" \
  APP_DIST_DIR="$ROOT/app/dist" \
  COMPUTER_SUPERVISOR_URL="${COMPUTER_SUPERVISOR_URL:-http://localhost:4500}" \
  SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN:-openbot-dev-supervisor-token}" \
  COMPUTER_TOKEN="${COMPUTER_TOKEN:-openbot-dev-computer-token}" \
  bun --env-file=../.env src/index.ts
