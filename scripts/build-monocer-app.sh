#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${1:-$HOME/Applications/MONOCER.app}"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc is required to build the MONOCER desktop app." >&2
  exit 1
fi

mkdir -p "$OUTPUT/Contents/MacOS" "$OUTPUT/Contents/Resources"
swiftc "$ROOT/desktop/macos/MONOCERDesktop.swift" \
  -o "$OUTPUT/Contents/MacOS/MONOCER" \
  -framework Cocoa \
  -framework WebKit
cp "$ROOT/desktop/macos/Info.plist" "$OUTPUT/Contents/Info.plist"
chmod +x "$OUTPUT/Contents/MacOS/MONOCER"
echo "Built $OUTPUT"
