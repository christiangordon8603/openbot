#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# macOS privacy controls can deny launchd access to a repository under Documents. Keep the
# editable checkout there, but use the GitHub-backed runtime checkout when one has been prepared.
ROOT="${MONOCER_RUNTIME_ROOT:-$SOURCE_ROOT}"
if [[ "$ROOT" == "$HOME/Documents/"* && -d "$HOME/monocer-openbot" ]]; then
  ROOT="$HOME/monocer-openbot"
fi
LABEL="com.monocer.openbot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/monocer-watchdog.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$ROOT/.logs/launch-agent.log</string>
  <key>StandardErrorPath</key>
  <string>$ROOT/.logs/launch-agent.error.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# The launch agent deliberately abandons its service children, but an older watchdog is itself a
# parent process and would otherwise survive a reinstall beside the new one. Boot it out first so
# launchd has released the job before the preserved parent is cleaned up.
for old_pid in $(pgrep -f "^/bin/bash $ROOT/scripts/monocer-watchdog.sh$" || true); do
  kill "$old_pid" 2>/dev/null || true
done
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
echo "MONOCER auto-start enabled: $PLIST"
