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

type Store = { routines: Routine[]; runs: RoutineRun[]; handoffs: Handoff[] };

const port = Number.parseInt(process.env.ROUTINES_PORT ?? "4400", 10);
const filePath = process.env.ROUTINES_FILE ?? `${process.cwd()}/.data/monocer-routines.json`;
const agentEndpoint = process.env.MANAGED_AGENT_AG_UI_URL?.trim();
const agentToken = process.env.MANAGED_AGENT_TOKEN?.trim();
const tickMs = 15_000;
let writeQueue = Promise.resolve();

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

async function readStore(): Promise<Store> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return { routines: [], runs: [], handoffs: [] };
    const parsed = (await file.json()) as Partial<Store>;
    return {
      routines: Array.isArray(parsed.routines) ? parsed.routines : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs.slice(-500) : [],
      handoffs: Array.isArray(parsed.handoffs) ? parsed.handoffs.slice(-500) : [],
    };
  } catch {
    return { routines: [], runs: [], handoffs: [] };
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
      "access-control-allow-origin": "http://localhost:3001",
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
  if (!agentEndpoint || !agentToken) {
    run.status = "failed";
    run.error = "The Codex bridge is not configured.";
    run.finishedAt = now();
    return;
  }

  try {
    const response = await fetch(agentEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": agentToken,
      },
      body: JSON.stringify({
        threadId: `routine:${routine.id}`,
        runId: run.id,
        messages: [
          {
            id: `routine-message:${run.id}`,
            role: "user",
            content: routine.prompt,
          },
        ],
        forwardedProps: { openbotBotId: routine.agentId, openbotRoutineId: routine.id },
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok) throw new Error(`Codex bridge returned ${response.status}.`);

    const body = await response.text();
    const output: string[] = [];
    for (const line of body.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6)) as { type?: string; delta?: string; message?: string };
        if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta === "string") output.push(event.delta);
        if (event.type === "RUN_ERROR") throw new Error(event.message ?? "The routine failed.");
      } catch (error) {
        if (error instanceof Error && error.message !== "Unexpected end of JSON input") throw error;
      }
    }
    run.output = output.join("").trim();
    run.status = "succeeded";
    run.finishedAt = now();
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    run.finishedAt = now();
  }
}

async function invokeHandoff(handoff: Handoff) {
  if (!agentEndpoint || !agentToken) {
    handoff.status = "failed";
    handoff.error = "The Codex bridge is not configured.";
    handoff.finishedAt = now();
    return;
  }

  try {
    const response = await fetch(agentEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": agentToken,
      },
      body: JSON.stringify({
        threadId: `handoff:${handoff.id}`,
        runId: handoff.id,
        messages: [
          {
            id: `handoff-message:${handoff.id}`,
            role: "user",
            content: [
              `You are receiving a handoff from the ${handoff.fromAgentId} MONOCER lane.`,
              `Complete this task as the ${handoff.toAgentId} lane:`,
              handoff.task,
              ...(handoff.context ? [`Context from the previous lane:\n${handoff.context}`] : []),
              "Return a concise result that the originating lane can use.",
            ].join("\n\n"),
          },
        ],
        forwardedProps: {
          openbotBotId: handoff.toAgentId,
          openbotHandoffId: handoff.id,
          openbotFromBotId: handoff.fromAgentId,
        },
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok) throw new Error(`Codex bridge returned ${response.status}.`);
    const body = await response.text();
    const output: string[] = [];
    for (const line of body.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice(6)) as { type?: string; delta?: string; message?: string };
      if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta === "string") output.push(event.delta);
      if (event.type === "RUN_ERROR") throw new Error(event.message ?? "The handoff failed.");
    }
    handoff.output = output.join("").trim();
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

async function runRoutine(routine: Routine) {
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
  await saveStore(finished);
  console.info(JSON.stringify({ type: "routine-run", routineId: routine.id, runId: run.id, status: run.status }));
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
