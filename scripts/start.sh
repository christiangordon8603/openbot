#!/usr/bin/env bash
#
# Start the local OpenBot stack and verify each service answers as OpenBot.
# Safe to rerun: matching services are left running, and unrelated port holders are reported.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LOGS="$ROOT/.logs"
mkdir -p "$LOGS"

if [ ! -f "$ROOT/.env" ]; then
  printf '\033[31m%s\033[0m\n' ".env is missing. Copy .env.example to .env and fill in the required settings."
  exit 1
fi

# The environment first, then .env, then the default. Compose and the API server both read .env, so a
# port or token configured there is what this script must use as well.
setting() {
  local name="$1" fallback="$2" value="${!1:-}"
  if [ -z "$value" ]; then
    value="$(grep -E "^$name=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  fi
  printf '%s' "${value:-$fallback}"
}

APP_PORT="$(setting APP_PORT 3010)"
SERVER_PORT="$(setting SERVER_PORT 3001)"
COMPUTER_PORT="$(setting COMPUTER_PORT 4100)"
BOT_PORT="$(setting BOT_PORT 4200)"
LANGGRAPH_PORT="$(setting LANGGRAPH_PORT 4201)"
CODEX_BRIDGE_PORT="$(setting CODEX_BRIDGE_PORT 4203)"
SUPERVISOR_PORT="$(setting SUPERVISOR_PORT 4500)"
ROUTINES_PORT="$(setting ROUTINES_PORT 4400)"
ONE_COMPUTER_EACH="${OPENBOT_ONE_COMPUTER_EACH:-true}"
export APP_PORT SERVER_PORT
SUPERVISOR_TOKEN="$(setting SUPERVISOR_TOKEN openbot-dev-supervisor-token)"
COMPUTER_TOKEN="$(setting COMPUTER_TOKEN openbot-dev-computer-token)"

# The secret the server sends to a managed Bot, generated and written back on first run.
#
# Not a fixed default like the two above. Those reach services bound to loopback; a Bot publishes a
# port, so a well-known token from a public repository would be no boundary at all. Generated once
# per machine and persisted, because the server and the Bot are separate processes that have to
# agree on it across restarts.
#
# Written into .env rather than exported for this run alone, so `docker compose up` by hand later
# sees the same value the script used.
# The laptop stack uses the signed-in Codex bridge by default. The one-container image does not
# carry a host bridge, so this default stays in the script rather than in .env: a
# `docker run --env-file .env` must not inherit a URL that points at a process the image does not
# contain.
MANAGED_AGENT_AG_UI_URL="$(setting MANAGED_AGENT_AG_UI_URL "http://localhost:${CODEX_BRIDGE_PORT}/ag-ui")"
export MANAGED_AGENT_AG_UI_URL

# Whether this run minted a secret that something already running may not have.
#
# A process that is answering is not necessarily a process holding the current configuration, and
# the two are easy to confuse because one is observable and the other is not. Everything below that
# skips work because a service "is already up" has to consult this first.
SECRETS_ROTATED=false

MANAGED_AGENT_TOKEN="$(setting MANAGED_AGENT_TOKEN "")"
if [ -z "$MANAGED_AGENT_TOKEN" ]; then
  SECRETS_ROTATED=true
  MANAGED_AGENT_TOKEN="$(openssl rand -base64 32)"
  if grep -qE '^MANAGED_AGENT_TOKEN=' "$ROOT/.env"; then
    # A present but empty line, which is what .env.example ships.
    tmp="$(mktemp)"
    grep -vE '^MANAGED_AGENT_TOKEN=' "$ROOT/.env" > "$tmp"
    printf 'MANAGED_AGENT_TOKEN=%s\n' "$MANAGED_AGENT_TOKEN" >> "$tmp"
    mv "$tmp" "$ROOT/.env"
  else
    printf '\nMANAGED_AGENT_TOKEN=%s\n' "$MANAGED_AGENT_TOKEN" >> "$ROOT/.env"
  fi
  printf '\033[2m%s\033[0m\n' "Generated MANAGED_AGENT_TOKEN and wrote it to .env."
fi
export MANAGED_AGENT_TOKEN

# The secret a framework Bot presents when it calls a tool back through this server. The other
# direction of the pair above: that one is the server proving itself to the Bot, this one is the Bot
# proving itself to the server, and they are deliberately two different secrets.
#
# Generated here for the same reason, and it has to be. `.env.example` ships it empty, which is the
# right default for a deployment: absent, no Bot may call tools back and it is told so rather than
# quietly allowed. On a laptop that default meant every MCP tool was dead on arrival. An
# administrator could enable Google Drive, grant `search_files` to a Bot, read "May call this tool"
# on the grant screen, and get "This Bot has no credential for calling tools back through its
# deployment" on every single call, with no audit row, because the call never reached the server to
# be recorded.
AGENT_TOOL_TOKEN="$(setting AGENT_TOOL_TOKEN "")"
if [ -z "$AGENT_TOOL_TOKEN" ]; then
  SECRETS_ROTATED=true
  AGENT_TOOL_TOKEN="$(openssl rand -base64 32)"
  if grep -qE '^AGENT_TOOL_TOKEN=' "$ROOT/.env"; then
    # A present but empty line, which is what .env.example ships.
    tmp="$(mktemp)"
    grep -vE '^AGENT_TOOL_TOKEN=' "$ROOT/.env" > "$tmp"
    printf 'AGENT_TOOL_TOKEN=%s\n' "$AGENT_TOOL_TOKEN" >> "$tmp"
    mv "$tmp" "$ROOT/.env"
  else
    printf '\nAGENT_TOOL_TOKEN=%s\n' "$AGENT_TOOL_TOKEN" >> "$ROOT/.env"
  fi
  printf '\033[2m%s\033[0m\n' "Generated AGENT_TOOL_TOKEN and wrote it to .env."
fi
export AGENT_TOOL_TOKEN

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
info()  { printf '\033[2m%s\033[0m\n' "$1"; }

holder() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fcn 2>/dev/null | awk '/^c/{c=substr($0,2)} /^n/{print c" ("substr($0,2)")"; exit}' || true
}

require_free_or_ours() {
  local port="$1" name="$2" who
  who="$(holder "$port")"
  [ -z "$who" ] && return 0
  if curl -fsS --max-time 3 "http://localhost:$port/health" >/dev/null 2>&1 \
     || curl -fsS --max-time 3 "http://localhost:$port/api/capabilities" >/dev/null 2>&1 \
     || curl -fsS --max-time 3 "http://localhost:$port/" >/dev/null 2>&1; then
    info "  $name: already up on $port ($who)"
    return 0
  fi
  red "  $name: port $port is held by something else: $who"
  red "  Re-run with ${name^^}_PORT=<free port>, or stop that process yourself."
  exit 1
}

wait_for() {
  local url="$1" name="$2" tries="${3:-40}"
  for _ in $(seq 1 "$tries"); do
    curl -fsS --max-time 3 "$url" >/dev/null 2>&1 && { green "  $name ready"; return 0; }
    sleep 1
  done
  red "  $name never became ready at $url"
  red "  Log: $LOGS/${name}.log"
  exit 1
}

echo
echo "OpenBot"
echo "======="

info "1/4  Docker services"
SERVICES=(postgres monocer-linux)
if [ "$ONE_COMPUTER_EACH" = "true" ]; then
  SERVICES+=(supervisor)
fi
#
# The MONOCER profile uses the signed-in Codex bridge on the host. The stock Qwen-backed Bot
# containers remain available in docker-compose for the upstream example, but are deliberately not
# started here so a Codex subscription deployment does not depend on a local model.
#
# This used to skip one that answered its health route, which sounds like an optimisation and is
# actually a correctness bug: answering says the process is alive, not that its environment still
# matches the deployment's. A skipped service is never handed to `docker compose up`, so compose
# never compares its configuration and never recreates it.
#
# Which is how a Bot ends up holding a secret this deployment no longer accepts. `AGENT_TOOL_TOKEN`
# is generated above and written to .env; if the container was answering, it kept the previous one,
# and every tool call it made was refused at the door. It returns nothing to its own model, and the
# model tells the person there were no results — a false negative delivered as an answer.
#
# `docker compose up -d` is declarative and does nothing for a service whose configuration has not
# changed, so naming them all costs a comparison and buys the guarantee that what is running is what
# this run configured.
for svc in agent-computer; do
  SERVICES+=("$svc")
done

export SUPERVISOR_TOKEN COMPUTER_TOKEN
export COMPUTER_PORT BOT_PORT LANGGRAPH_PORT SUPERVISOR_PORT ROUTINES_PORT
docker compose up -d --build "${SERVICES[@]}" >/dev/null
if ! docker compose run --rm --build migrate >"$LOGS/migrate.log" 2>&1; then
  red "  Migrations did not apply. The database is not the schema this server expects."
  red "  Log: $LOGS/migrate.log"
  exit 1
fi
wait_for "http://localhost:$COMPUTER_PORT/health" "agent-computer"
wait_for "http://127.0.0.1:${MONOCER_DESKTOP_PORT:-6080}/" "monocer-linux"
CLAUDE_BRIDGE_LOG="$LOGS/claude-bridge.log"
CLAUDE_BRIDGE_PID="$LOGS/claude-bridge.pid"
if ! curl -fsS --max-time 3 "http://127.0.0.1:${CLAUDE_BRIDGE_PORT:-4202}/health" >/dev/null 2>&1; then
  (cd "$ROOT/agent-claude" && PORT="${CLAUDE_BRIDGE_PORT:-4202}" bun --env-file=../.env src/index.ts >>"$CLAUDE_BRIDGE_LOG" 2>&1 & echo $! >"$CLAUDE_BRIDGE_PID")
fi
wait_for "http://127.0.0.1:${CLAUDE_BRIDGE_PORT:-4202}/health" "claude-bridge"

CODEX_BRIDGE_LOG="$LOGS/codex-bridge.log"
CODEX_BRIDGE_PID="$LOGS/codex-bridge.pid"
if ! curl -fsS --max-time 3 "http://127.0.0.1:${CODEX_BRIDGE_PORT:-4203}/health" >/dev/null 2>&1; then
  (cd "$ROOT/agent-codex" && PORT="${CODEX_BRIDGE_PORT:-4203}" bun --env-file=../.env src/index.ts >>"$CODEX_BRIDGE_LOG" 2>&1 & echo $! >"$CODEX_BRIDGE_PID")
fi
wait_for "http://127.0.0.1:${CODEX_BRIDGE_PORT:-4203}/health" "codex-bridge"

ROUTINES_LOG="$LOGS/routines.log"
if ! curl -fsS --max-time 3 "http://127.0.0.1:$ROUTINES_PORT/health" >/dev/null 2>&1; then
  (ROUTINES_PORT="$ROUTINES_PORT" ROUTINES_FILE="$ROOT/.data/monocer-routines.json" \
    bun "$ROOT/scripts/monocer-routines.ts" >>"$ROUTINES_LOG" 2>&1 &)
fi
wait_for "http://127.0.0.1:$ROUTINES_PORT/health" "routines"

# Serve the branded MONOCER interface from the same origin as the API. This is what makes the local
# installation behave like one app at localhost:3001 instead of leaving the user with a separate
# Vite development port that disappears when its shell closes.
APP_DIST_DIR="$ROOT/app/dist"
if [ ! -f "$APP_DIST_DIR/index.html" ]; then
  info "  building the MONOCER interface for the server"
  if ! bun --cwd app build >"$LOGS/app-build.log" 2>&1; then
    red "  The MONOCER interface did not build."
    red "  Log: $LOGS/app-build.log"
    exit 1
  fi
fi

for table in agent_profiles agent_preferences; do
  if ! docker compose exec -T postgres \
       psql -U openbot -d openbot -tAc "select to_regclass('public.$table')" 2>/dev/null \
       | grep -q "^$table$"; then
    red "  $table is missing. Run: bun run --cwd server db:migrate"
    exit 1
  fi
done
green "  coworker tables migrated"

# The two local bridges are intentionally small packages outside the main workspace package. Install
# their AG-UI dependencies on first run so a fresh checkout is runnable without any manual setup;
# `--no-save` keeps generated dependency state out of the repository.
for bridge in agent-claude agent-codex; do
  if [ ! -d "$ROOT/$bridge/node_modules/@ag-ui/core" ]; then
    info "  installing $bridge dependencies"
    (cd "$ROOT/$bridge" && bun install --no-save >/dev/null)
  fi
done

# Resolved at the top, where the default that .env deliberately does not carry is applied. Reading
# .env again here would have demanded the line be present in a file the comment above that default
# says must not contain it, which is how this came to refuse every fresh clone: `cp .env.example
# .env` leaves it commented out, so the grep matched nothing.
#
# It failed silently, too. Under `set -o pipefail` a grep that matches nothing fails its whole
# pipeline, and `set -e` then aborts the assignment before the check below could say why. The same
# grep survives inside `setting()` only because `local v="$(...)"` takes `local`'s own exit status
# and masks it. So: report what was resolved, and do not re-read the file.
green "  managed coworker endpoint: $MANAGED_AGENT_AG_UI_URL"

info "2/4  Server"
require_free_or_ours "$SERVER_PORT" server
#
# A running server is left alone UNLESS this run minted a secret, because it read its environment
# once at startup and has no way to notice the file changed underneath it.
#
# Skipping it on "already answering" is the same mistake the Bot containers had: answering proves the
# process is alive, not that it agrees with the deployment. A server holding the previous
# `AGENT_TOOL_TOKEN` refuses every callback its own Bots make, which reaches a person as "no results"
# rather than as an error.
if [ "$SECRETS_ROTATED" = "true" ]; then
  info "  a secret was generated this run, so the server is restarted to pick it up"
  pkill -f "bun --env-file=../.env src/index.ts" >/dev/null 2>&1 || true
  sleep 1
fi
if ! curl -fsS --max-time 3 "http://localhost:$SERVER_PORT/api/capabilities" >/dev/null 2>&1; then
  if [ "$ONE_COMPUTER_EACH" = "true" ]; then
    (cd server && PORT="$SERVER_PORT" APP_DIST_DIR="../app/dist" \
      COMPUTER_SUPERVISOR_URL="http://localhost:$SUPERVISOR_PORT" \
      SUPERVISOR_TOKEN="$SUPERVISOR_TOKEN" \
      COMPUTER_TOKEN="$COMPUTER_TOKEN" \
      bun --env-file=../.env src/index.ts >"$LOGS/server.log" 2>&1 &)
  else
    (cd server && PORT="$SERVER_PORT" APP_DIST_DIR="../app/dist" bun --env-file=../.env src/index.ts >"$LOGS/server.log" 2>&1 &)
  fi
fi
wait_for "http://localhost:$SERVER_PORT/api/capabilities" "server"

info "3/4  Runtime health"
INFO="$(curl -fsS --max-time 8 "http://localhost:$SERVER_PORT/api/copilotkit/info")"
python3 - "$INFO" <<'PY'
import json, sys
info = json.loads(sys.argv[1])
status, agents = info.get("licenseStatus"), list(info.get("agents", {}))
if status != "valid":
    print(f"\033[31m  licence is '{status}', not 'valid'.\033[0m")
    print("\033[31m  Run: npx copilotkit@latest login && npx copilotkit@latest license --write\033[0m")
    print("\033[31m  See README.md for Intelligence setup.\033[0m")
    raise SystemExit(1)
if not agents:
    print("\033[31m  No Bots registered.\033[0m")
    raise SystemExit(1)
print(f"\033[32m  licence valid · mode {info.get('mode')} · Bots: {', '.join(agents)}\033[0m")
PY

info "4/4  App"
require_free_or_ours "$APP_PORT" app
if ! curl -fsS --max-time 3 "http://localhost:$APP_PORT/" >/dev/null 2>&1; then
  (cd app && bun run dev --port "$APP_PORT" --strictPort >"$LOGS/app.log" 2>&1 &)
fi
wait_for "http://localhost:$APP_PORT/" "app"

cat <<EOF

$(green "Ready. http://localhost:$APP_PORT")

Next steps:

  - Direct Bot chat:       http://localhost:$APP_PORT/bot
  - Coworkers:             http://localhost:$APP_PORT/agents
  - Audit trail:           http://localhost:$APP_PORT/admin/audit
  - Boundaries/policy:     http://localhost:$APP_PORT/admin/boundaries
  - Setup docs:            README.md
  - Configuration docs:    docs/configuration.md

Try:

  1. Open /bot and ask: Open news.ycombinator.com and tell me the top story.
  2. Create a coworker in /agents and start a channel with it.
  3. Review browser/file actions in /admin/audit.
  4. Add a deny rule in /admin/boundaries, then retry the same action.

Logs: $LOGS
Stop Docker services: docker compose down
  A Bot's computer is made by the supervisor rather than by compose, so it keeps running:
  docker rm -f \$(docker ps -q --filter label=openbot.supervisor=true)
  Its files and its browser profile are volumes and survive either way.
Stop host app/server: kill the processes using ports $APP_PORT and $SERVER_PORT
EOF
