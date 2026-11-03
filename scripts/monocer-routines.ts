/**
 * MONOCER's local background routine runner.
 *
 * This is deliberately a small, dependency-free process. Routines are durable JSON records on the
 * local machine, and each run goes through the same authenticated AG-UI Codex bridge as a chat
 * turn. The service is loopback-only and therefore is an operator surface, not a public endpoint.
 */

type Routine = {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  /** Bounded cross-run context; tool payloads are intentionally not persisted. */
  memory?: Array<{ role: "user" | "assistant"; content: string }>;
};

type RoutineRun = {
  id: string;
  routineId: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  output?: string;
  error?: string;
};

type Handoff = {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  task: string;
  context?: string;
  status: "running" | "succeeded" | "failed";
  createdAt: string;
  finishedAt?: string;
  output?: string;
  error?: string;
};

type MissionResult = {
  agentId: string;
  status: "succeeded" | "failed";
  output?: string;
  error?: string;
};

type Mission = {
  id: string;
  task: string;
  agentIds: string[];
  synthesisAgentId: string;
  status: "running" | "succeeded" | "partial" | "failed";
  createdAt: string;
  finishedAt?: string;
  results: MissionResult[];
  synthesis?: string;
  error?: string;
};

type Store = { routines: Routine[]; runs: RoutineRun[]; handoffs: Handoff[]; missions: Mission[] };

const MAX_MEMORY_MESSAGES = 12;
const MAX_MEMORY_CHARS = 24_000;

const port = Number.parseInt(process.env.ROUTINES_PORT ?? "4400", 10);
const filePath = process.env.ROUTINES_FILE ?? `${process.cwd()}/.data/monocer-routines.json`;
const agentEndpoint = process.env.MANAGED_AGENT_AG_UI_URL?.trim();
const agentToken = process.env.MANAGED_AGENT_TOKEN?.trim();
const serverEndpoint = process.env.OPENBOT_SERVER_URL?.trim() ?? "http://127.0.0.1:3001";
const tickMs = 15_000;
let writeQueue = Promise.resolve();
const activeRoutines = new Set<string>();
const activeMissions = new Set<string>();

const backgroundTools = [
  { type: "function", name: "computer_navigate", description: "Open a web page on the assigned MONOCER computer. Returns its title and readable text.", parameters: { type: "object", properties: { url: { type: "string", description: "Full web address, including https://" } }, required: ["url"], additionalProperties: false } },
  { type: "function", name: "computer_read", description: "Read the page currently open on the assigned MONOCER computer.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { type: "function", name: "computer_snapshot", description: "List actionable controls on the current page, including refs and snapshotId.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { type: "function", name: "computer_click", description: "Click a control using its ref and snapshotId from the latest snapshot.", parameters: { type: "object", properties: { ref: { type: "string" }, snapshotId: { type: "number" } }, required: ["ref", "snapshotId"], additionalProperties: false } },
  { type: "function", name: "computer_type", description: "Type into a control using its ref and snapshotId from the latest snapshot.", parameters: { type: "object", properties: { ref: { type: "string" }, snapshotId: { type: "number" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["ref", "snapshotId", "text"], additionalProperties: false } },
  { type: "function", name: "computer_key", description: "Press a key on the assigned MONOCER computer.", parameters: { type: "object", properties: { key: { type: "string" }, ref: { type: "string" }, snapshotId: { type: "number" } }, required: ["key"], additionalProperties: false } },
  { type: "function", name: "computer_scroll", description: "Scroll the assigned MONOCER computer vertically.", parameters: { type: "object", properties: { deltaY: { type: "number" } }, additionalProperties: false } },
  { type: "function", name: "computer_screenshot", description: "Capture the current assigned computer screen for visual inspection.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { type: "function", name: "computer_list_files", description: "List files in the assigned computer workspace.", parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } },
  { type: "function", name: "computer_read_file", description: "Read a text file from the assigned computer workspace.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { type: "function", name: "computer_write_file", description: "Write a text file to the assigned computer workspace.", parameters: { type: "object", properties: { path: { type: "string" }, contents: { type: "string" }, append: { type: "boolean" } }, required: ["path", "contents"], additionalProperties: false } },
  { type: "function", name: "computer_run_command", description: "Run a bounded command on the assigned MONOCER computer and return its output.", parameters: { type: "object", properties: { command: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"], additionalProperties: false } },
] as const;

type BackgroundMessage = { role: "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
type BackgroundToolCall = { id: string; name: string; arguments: Record<string, unknown> };

async function runComputerTool(agentId: string, call: BackgroundToolCall) {
  const routes: Record<string, { method: string; path: string }> = {
    computer_navigate: { method: "POST", path: "/navigate" }, computer_read: { method: "GET", path: "/read" }, computer_snapshot: { method: "POST", path: "/snapshot" }, computer_click: { method: "POST", path: "/click" }, computer_type: { method: "POST", path: "/type" }, computer_key: { method: "POST", path: "/key" }, computer_scroll: { method: "POST", path: "/scroll" }, computer_screenshot: { method: "GET", path: "/screenshot" }, computer_list_files: { method: "POST", path: "/files/list" }, computer_read_file: { method: "POST", path: "/files/read" }, computer_write_file: { method: "POST", path: "/files/write" }, computer_run_command: { method: "POST", path: "/exec" },
  };
  const route = routes[call.name];
  if (!route) return { ok: false, error: `Unsupported background tool: ${call.name}` };
  const response = await fetch(`${serverEndpoint}/api/computers/${encodeURIComponent(agentId)}${route.path}`, { method: route.method, headers: { "content-type": "application/json" }, ...(route.method === "GET" ? {} : { body: JSON.stringify(call.arguments) }), signal: AbortSignal.timeout(120_000) });
  const body = await response.text();
  let parsed: unknown = body;
  try { parsed = JSON.parse(body); } catch {}
  return response.ok ? parsed : { ok: false, status: response.status, result: parsed };
}

async function invokeAgent(
  agentId: string,
  threadId: string,
  runId: string,
  messages: BackgroundMessage[],
  tools = backgroundTools,
) {
  if (!agentEndpoint || !agentToken) throw new Error("The Codex bridge is not configured.");
  let history = [...messages];
  for (let step = 0; step < 8; step += 1) {
    const response = await fetch(agentEndpoint, { method: "POST", headers: { "content-type": "application/json", "x-openbot-agent-token": agentToken }, body: JSON.stringify({ threadId, runId: `${runId}:${step}`, messages: history, tools, forwardedProps: { openbotBotId: agentId, openbotBackgroundRunId: runId } }), signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok) throw new Error(`Codex bridge returned ${response.status}.`);
    const body = await response.text();
    const output: string[] = [];
    const calls = new Map<string, BackgroundToolCall>();
    for (const line of body.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      let event: { type?: string; delta?: string; message?: string; toolCallId?: string; toolCallName?: string };
      try { event = JSON.parse(line.slice(6)) as typeof event; } catch { continue; }
      if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta === "string") output.push(event.delta);
      if (event.type === "RUN_ERROR") throw new Error(event.message ?? "The background run failed.");
      if (event.type === "TOOL_CALL_START" && event.toolCallId && event.toolCallName) calls.set(event.toolCallId, { id: event.toolCallId, name: event.toolCallName, arguments: {} });
      if (event.type === "TOOL_CALL_ARGS" && event.toolCallId) {
        const call = calls.get(event.toolCallId);
        if (call && typeof event.delta === "string") {
          try { call.arguments = JSON.parse(event.delta) as Record<string, unknown>; } catch { throw new Error(`Codex sent invalid arguments for ${call.name}.`); }
        }
      }
    }
    if (calls.size === 0) return output.join("").trim();
    const callMessages = [...calls.values()];
    history = [...history, { role: "assistant", content: "", toolCalls: callMessages.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }, ...await Promise.all(callMessages.map(async (call) => ({ role: "tool" as const, toolCallId: call.id, content: JSON.stringify(await runComputerTool(agentId, call)) })))];
  }
  throw new Error("The background run exceeded its eight-step tool limit.");
}

function now() {
  return new Date().toISOString();
}

function safeId(value: unknown) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
    ? value
    : null;
}

function text(value: unknown, max: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : null;
}

function boundedMemory(messages: Array<{ role: "user" | "assistant"; content: string }>) {
  const kept: Array<{ role: "user" | "assistant"; content: string }> = [];
  let chars = 0;
  for (const message of messages.slice(-MAX_MEMORY_MESSAGES).reverse()) {
    const content = message.content.trim();
    if (!content) continue;
    if (chars + content.length > MAX_MEMORY_CHARS && kept.length > 0) break;
    kept.push({ role: message.role, content: content.slice(0, MAX_MEMORY_CHARS) });
    chars += content.length;
  }
  return kept.reverse();
}

async function readStore(): Promise<Store> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return { routines: [], runs: [], handoffs: [], missions: [] };
    const parsed = (await file.json()) as Partial<Store>;
    return {
      routines: Array.isArray(parsed.routines)
        ? parsed.routines.map((routine) => ({
            ...routine,
            ...(Array.isArray(routine.memory)
              ? {
                  memory: boundedMemory(
                    routine.memory.filter(
                      (message) =>
                        message &&
                        (message.role === "user" || message.role === "assistant") &&
                        typeof message.content === "string",
                    ),
                  ),
                }
              : {}),
          }))
        : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-500) : [],
      handoffs: Array.isArray(parsed.handoffs) ? parsed.handoffs.slice(-500) : [],
      missions: Array.isArray(parsed.missions) ? parsed.missions.slice(-100) : [],
    };
  } catch {
    return { routines: [], runs: [], handoffs: [], missions: [] };
  }
}

async function saveStore(store: Store) {
  const serialized = JSON.stringify(store, null, 2);
  writeQueue = writeQueue.then(async () => {
    await Bun.$`mkdir -p ${filePath.substring(0, filePath.lastIndexOf("/"))}`;
    const temporary = `${filePath}.tmp-${process.pid}`;
    await Bun.write(temporary, serialized);
    await Bun.$`mv ${temporary} ${filePath}`;
  });
  await writeQueue;
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "access-control-allow-origin": "http://localhost:3010",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

async function parseJson(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function invoke(routine: Routine, run: RoutineRun) {
  try {
    const prior = routine.memory ?? [];
    const current = { role: "user" as const, content: routine.prompt };
    run.output = await invokeAgent(routine.agentId, `routine:${routine.id}`, run.id, [...prior, current]);
    routine.memory = boundedMemory([
      ...prior,
      current,
      { role: "assistant" as const, content: run.output },
    ]);
    run.status = "succeeded";
    run.finishedAt = now();
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    run.finishedAt = now();
  }
}

async function invokeHandoff(handoff: Handoff) {
  try {
    handoff.output = await invokeAgent(handoff.toAgentId, `handoff:${handoff.id}`, handoff.id, [{ role: "user", content: [
      `You are receiving a handoff from the ${handoff.fromAgentId} MONOCER lane.`,
      `Complete this task as the ${handoff.toAgentId} lane:`,
      handoff.task,
      ...(handoff.context ? [`Context from the previous lane:\n${handoff.context}`] : []),
      "Return a concise result that the originating lane can use.",
    ].join("\n\n") }]);
    handoff.status = "succeeded";
    handoff.finishedAt = now();
  } catch (error) {
    handoff.status = "failed";
    handoff.error = error instanceof Error ? error.message : String(error);
    handoff.finishedAt = now();
  }
}

async function runHandoff(handoff: Handoff) {
  await invokeHandoff(handoff);
  const store = await readStore();
  const saved = store.handoffs.find((item) => item.id === handoff.id);
  if (saved) Object.assign(saved, handoff);
  await saveStore(store);
  console.info(JSON.stringify({ type: "agent-handoff", handoffId: handoff.id, status: handoff.status }));
}

async function runMission(mission: Mission) {
  if (activeMissions.has(mission.id)) return;
  activeMissions.add(mission.id);
  try {
    const workerResults = await Promise.all(
      mission.agentIds.map(async (agentId): Promise<MissionResult> => {
        try {
          const output = await invokeAgent(
            agentId,
            `mission:${mission.id}:${agentId}`,
            `${mission.id}:${agentId}`,
            [{
              role: "user",
              content: [
                `You are the ${agentId} lane in a MONOCER multi-agent mission.`,
                "Analyze the task from your specialist perspective.",
                "Do not use browser or computer tools in this parallel pass; return concise findings, assumptions, risks, and concrete recommendations for the lead lane.",
                `Mission task:\n${mission.task}`,
              ].join("\n\n"),
            }],
            [],
          );
          return { agentId, status: "succeeded", output };
        } catch (error) {
          return { agentId, status: "failed", error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    mission.results = workerResults;
    const evidence = workerResults.map((result) => [
      `LANE: ${result.agentId}`,
      `STATUS: ${result.status}`,
      result.output ?? `ERROR: ${result.error ?? "No result."}`,
    ].join("\n")).join("\n\n---\n\n");
    try {
      mission.synthesis = await invokeAgent(
        mission.synthesisAgentId,
        `mission:${mission.id}:synthesis`,
        `${mission.id}:synthesis`,
        [{
          role: "user",
          content: [
            `You are the lead ${mission.synthesisAgentId} lane for a MONOCER mission.`,
            "Synthesize the specialist findings into one decisive answer.",
            "Call out disagreement or missing evidence, then give prioritized next actions. Do not mention internal orchestration unless it helps explain a limitation.",
            `Original task:\n${mission.task}`,
            `Specialist findings:\n${evidence}`,
          ].join("\n\n"),
        }],
        [],
      );
    } catch (error) {
      mission.error = error instanceof Error ? error.message : String(error);
    }
    const successful = workerResults.filter((result) => result.status === "succeeded").length;
    mission.status = mission.synthesis && successful === workerResults.length ? "succeeded" : successful > 0 ? "partial" : "failed";
    mission.finishedAt = now();
  } catch (error) {
    mission.status = "failed";
    mission.error = error instanceof Error ? error.message : String(error);
    mission.finishedAt = now();
  } finally {
    const store = await readStore();
    const saved = store.missions.find((item) => item.id === mission.id);
    if (saved) Object.assign(saved, mission);
    await saveStore(store);
    activeMissions.delete(mission.id);
    console.info(JSON.stringify({ type: "mission", missionId: mission.id, status: mission.status }));
  }
}

async function runRoutine(routine: Routine) {
  if (activeRoutines.has(routine.id)) return false;
  activeRoutines.add(routine.id);
  try {
    const store = await readStore();
    const run: RoutineRun = {
      id: `run_${crypto.randomUUID()}`,
      routineId: routine.id,
      status: "running",
      startedAt: now(),
    };
    store.runs.push(run);
    const storedRoutine = store.routines.find((item) => item.id === routine.id);
    if (storedRoutine) storedRoutine.lastRunAt = run.startedAt;
    await saveStore(store);
    await invoke(routine, run);
    const finished = await readStore();
    const savedRun = finished.runs.find((item) => item.id === run.id);
    if (savedRun) Object.assign(savedRun, run);
    const savedRoutine = finished.routines.find((item) => item.id === routine.id);
    if (savedRoutine && routine.memory) savedRoutine.memory = routine.memory;
    await saveStore(finished);
    console.info(JSON.stringify({ type: "routine-run", routineId: routine.id, runId: run.id, status: run.status }));
    return true;
  } finally {
    activeRoutines.delete(routine.id);
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const store = await readStore();
    const current = Date.now();
    for (const routine of store.routines) {
      if (!routine.enabled || routine.intervalMinutes <= 0) continue;
      const last = routine.lastRunAt ? Date.parse(routine.lastRunAt) : 0;
      if (current - last < routine.intervalMinutes * 60_000) continue;
      await runRoutine(routine);
    }
  } finally {
    ticking = false;
  }
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({ ok: true });
    if (url.pathname === "/health") return json({ status: "ok", service: "monocer-routines" });
    if (url.pathname === "/routines" && request.method === "GET") return json(await readStore());
    if (url.pathname === "/handoffs" && request.method === "GET") return json({ handoffs: (await readStore()).handoffs });
    if (url.pathname === "/missions" && request.method === "GET") return json({ missions: (await readStore()).missions });
    if (url.pathname === "/missions" && request.method === "POST") {
      const input = await parseJson(request);
      const task = text(input?.task, 20_000);
      const agentIds = Array.isArray(input?.agentIds)
        ? [...new Set(input.agentIds.map(safeId).filter((value): value is string => Boolean(value)))].slice(0, 7)
        : [];
      const synthesisAgentId = safeId(input?.synthesisAgentId) ?? agentIds[0];
      if (!task || agentIds.length === 0 || !synthesisAgentId) return json({ error: "task, at least one agentId, and synthesisAgentId are required." }, 400);
      const mission: Mission = { id: `mission_${crypto.randomUUID()}`, task, agentIds, synthesisAgentId, status: "running", createdAt: now(), results: [] };
      const store = await readStore();
      store.missions.push(mission);
      await saveStore(store);
      void runMission(mission);
      return json({ mission }, 202);
    }
    const missionMatch = url.pathname.match(/^\/missions\/([^/]+)$/);
    if (missionMatch && request.method === "GET") {
      const mission = (await readStore()).missions.find((item) => item.id === missionMatch[1]);
      return mission ? json({ mission }) : json({ error: "Mission not found." }, 404);
    }
    if (url.pathname === "/handoffs" && request.method === "POST") {
      const input = await parseJson(request);
      const fromAgentId = safeId(input?.fromAgentId);
      const toAgentId = safeId(input?.toAgentId);
      const task = text(input?.task, 20_000);
      const context = input?.context === undefined ? undefined : text(input.context, 40_000);
      if (!fromAgentId || !toAgentId || !task) return json({ error: "fromAgentId, toAgentId, and task are required." }, 400);
      if (fromAgentId === toAgentId) return json({ error: "A handoff must name a different target lane." }, 400);
      const handoff: Handoff = { id: `handoff_${crypto.randomUUID()}`, fromAgentId, toAgentId, task, ...(context ? { context } : {}), status: "running", createdAt: now() };
      const store = await readStore();
      store.handoffs.push(handoff);
      await saveStore(store);
      void runHandoff(handoff);
      return json({ handoff }, 202);
    }
    const handoffMatch = url.pathname.match(/^\/handoffs\/([^/]+)$/);
    if (handoffMatch && request.method === "GET") {
      const handoff = (await readStore()).handoffs.find((item) => item.id === handoffMatch[1]);
      return handoff ? json({ handoff }) : json({ error: "Handoff not found." }, 404);
    }

    const match = url.pathname.match(/^\/routines\/([^/]+)(?:\/runs)?$/);
    if (!match) {
      if (url.pathname !== "/routines" || request.method !== "POST") return json({ error: "Not found." }, 404);
      const input = await parseJson(request);
      const id = safeId(input?.id);
      const name = text(input?.name, 120);
      const agentId = safeId(input?.agentId);
      const prompt = text(input?.prompt, 20_000);
      const intervalMinutes = Number(input?.intervalMinutes);
      if (!id || !name || !agentId || !prompt || !Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
        return json({ error: "id, name, agentId, prompt, and intervalMinutes >= 1 are required." }, 400);
      }
      const store = await readStore();
      if (store.routines.some((routine) => routine.id === id)) return json({ error: "That routine already exists." }, 409);
      const routine: Routine = { id, name, agentId, prompt, intervalMinutes, enabled: input?.enabled !== false, createdAt: now(), updatedAt: now() };
      store.routines.push(routine);
      await saveStore(store);
      return json({ routine }, 201);
    }

    const id = match[1];
    const store = await readStore();
    const routine = store.routines.find((item) => item.id === id);
    if (!routine) return json({ error: "Routine not found." }, 404);
    if (url.pathname.endsWith("/runs") && request.method === "GET") return json({ runs: store.runs.filter((run) => run.routineId === id) });
    if (request.method === "POST") {
      if (activeRoutines.has(id)) return json({ accepted: false, routineId: id, reason: "already_running" }, 409);
      void runRoutine(routine);
      return json({ accepted: true, routineId: id }, 202);
    }
    if (request.method === "PATCH") {
      const input = await parseJson(request);
      if (input?.enabled !== undefined) routine.enabled = input.enabled === true;
      if (input?.intervalMinutes !== undefined && Number.isFinite(Number(input.intervalMinutes)) && Number(input.intervalMinutes) >= 1) routine.intervalMinutes = Number(input.intervalMinutes);
      if (input?.prompt !== undefined && text(input.prompt, 20_000)) routine.prompt = text(input.prompt, 20_000) as string;
      routine.updatedAt = now();
      await saveStore(store);
      return json({ routine });
    }
    if (request.method === "DELETE") {
      store.routines = store.routines.filter((item) => item.id !== id);
      await saveStore(store);
      return json({ deleted: true });
    }
    return json({ error: "Method not allowed." }, 405);
  },
});

console.info(`MONOCER routines listening on http://127.0.0.1:${server.port}`);
setInterval(() => void tick(), tickMs);
void tick();
