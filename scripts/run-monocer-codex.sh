#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/agent-codex"
unset XPC_SERVICE_NAME
exec /opt/homebrew/bin/bun --env-file=../.env src/index.ts
