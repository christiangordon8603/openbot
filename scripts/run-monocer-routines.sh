#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
unset XPC_SERVICE_NAME
exec /opt/homebrew/bin/bun --env-file=.env scripts/monocer-routines.ts
