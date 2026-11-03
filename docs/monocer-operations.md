# MONOCER Operations Desk

This local profile turns OpenBot into the MONOCER operating layer: a branded control desk for the agency agents already being developed in Claude, with persistent Linux computers, live screen previews, human takeover, governed browser actions, routines, handoffs, and a local Codex subscription bridge.

## Current prototype

- **Control surface:** `http://localhost:3001`
- **Model:** Signed-in Codex/ChatGPT subscription via the local Codex app-server bridge
- **Browser workers:** one supervisor-managed Linux computer per registered agent
- **Linux workstation:** persistent Ubuntu XFCE desktop at `http://127.0.0.1:6080`
- **Agent transport:** AG-UI over HTTP
- **Primary signed-in model:** Codex model configured in `~/.codex/config.toml` through the local Codex app-server bridge
- **Cost posture:** local runtime plus the free CopilotKit project created during setup; no paid hosting or model API is required for the local path
- **Commercial posture:** OpenBot source selected from `ltinphan/openbot`, MIT licensed

## Agency lanes

The dashboard reserves seven operating lanes so the existing agency specialists can be connected without changing the MONOCER surface:

1. Strategy
2. Creative
3. Production
4. Research
5. Accounts
6. Operations
7. Studio

All seven MONOCER lanes are registered as remote AG-UI agents backed by the signed-in Codex bridge. General Assistant, Knowledge, and Risk Analyst remain registered as compatibility agents so existing channels and saved links continue to work.

## Connecting the Codex agents

Every MONOCER coworker now runs through the authenticated local Codex app-server session rather than an API key. The startup script launches both bridges; Codex is the default:

```text
http://127.0.0.1:4203/ag-ui
```

The seven lanes are already configured in `examples/fintech/agents.yaml`; they all point to the local AG-UI bridge:

```yaml
- id: strategy
  name: Strategy
  title: Strategic Direction
  role_description: Turn briefs into clear strategic choices and actions.
  avatar_seed: strategy
  type: remote-ag-ui
  endpoint: ${OPENBOT_AGENT_BOT_URL:-http://127.0.0.1:4203/ag-ui}
```

The Codex bridge forwards client-provided MONOCER tools into Codex as dynamic tools. Computer actions
are emitted back as AG-UI tool calls so the MONOCER surface executes them through its per-agent
computer, policy checks, audit trail, and human takeover flow. The separate Claude bridge remains
available at `http://127.0.0.1:4202/ag-ui` as a fallback. Keep any future external endpoint owned by
the deployment and provide authentication through the agent profile/vault path.

## Local operation

Start the container services with the repository's existing startup script, then run the server with the built app directory:

```text
cd work/openbot
scripts/start.sh
```

The startup script builds the branded interface when needed and serves it from the same
`http://localhost:3001` origin as the API.

The startup script also launches the persistent Linux workstation. Open `http://127.0.0.1:6080`
to view it. Its login is stored only in `.env`; do not expose port 6080 to the public internet. The
desktop's `/config` and `/workspace` volumes survive restarts, so browser sessions and agent files
remain available to the local computer layer.

The startup script also launches the local routine service at `http://127.0.0.1:4400`. Routines are
stored in `.data/monocer-routines.json`, run through the same authenticated Codex bridge, and keep
the latest 500 run records. The service accepts `GET /routines`, `POST /routines`, `POST
/routines/:id` for an immediate run, `PATCH /routines/:id`, `DELETE /routines/:id`, and `GET
/routines/:id/runs`. Each routine keeps a bounded, tool-free summary of its last few turns, so a
later scheduled run can continue the work without persisting browser payloads or secrets. A routine
already running rejects a second manual trigger. It is loopback-only and is intended to be managed
by the MONOCER interface.

Agent handoffs use the same service at `GET /handoffs`, `POST /handoffs`, and
`GET /handoffs/:id`; the MONOCER interface exposes them at `/handoffs`. To make the local stack
start automatically when the Mac user signs in, run:

```text
scripts/install-monocer-launch-agent.sh
```

That installs a per-user macOS LaunchAgent. It does not expose any service beyond loopback, and it
does not make the stack continue while the Mac is powered off; that requires moving the same Docker
volumes and processes to a remote Linux host.

This is the zero-cost local-cloud phase: the Linux computer runs inside Colima/Docker on the Mac.
Moving it to a remote Linux host later is a deployment change, not an agent rewrite, provided the
host keeps the same private network and persistent volumes.

`COMPUTER_SUPERVISOR_URL` is enabled in the local profile. The supervisor has provisioned a dedicated computer/profile for each registered agent, so concurrent work does not share browser tabs, cookies, or workspace files.

## Expansion order

1. Keep the seven lanes as the primary MONOCER roster.
2. Give each lane a narrow tool policy and its own prompt contract.
3. Add background routines and agent-to-agent handoffs on top of the persistent channels.
4. Move the supervisor and volumes to a remote Linux host when MONOCER must continue while the Mac is off.
5. Keep approval gates before any external send, publish, purchase, or account-changing action.
