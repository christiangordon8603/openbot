#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
unset XPC_SERVICE_NAME
cd "$ROOT/app"

exec bun run dev --port "${APP_PORT:-3010}" --strictPort
