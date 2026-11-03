import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";

const PORT = Number.parseInt(process.env.PORT ?? "4203", 10);
const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim();
const CODEX_MODEL = process.env.CODEX_MODEL?.trim() || undefined;
const WORKDIR = process.env.CODEX_WORKDIR?.trim() || process.cwd();
if (!MANAGED_AGENT_TOKEN) throw new Error("MANAGED_AGENT_TOKEN is required");

const CODEX_EXECUTABLE = (() => {
  const candidates = [
    process.env.CODEX_BIN?.trim(),
    Bun.which("codex"),
    `${homedir()}/.local/bin/codex`,
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return (
    candidates.find(
      (candidate) => candidate === "codex" || existsSync(candidate),
    ) ?? "codex"
  );
})();

type ModelSummary = {
  slug: string;
  displayName: string;
  description: string;
  supportedInApi: boolean;
  visibility: string;
};

const CODEX_HOME =
  process.env.CODEX_HOME?.trim() || `${process.env.HOME ?? ""}/.codex`;
const MODEL_CACHE_PATH = `${CODEX_HOME}/models_cache.codex_work_desktop.json`;

async function loadModelCatalog(): Promise<ModelSummary[]> {
  try {
    const cached = JSON.parse(await Bun.file(MODEL_CACHE_PATH).text()) as {
      models?: Array<Record<string, unknown>>;
    };
    return (cached.models ?? [])
      .map((model) => ({
        slug: String(model.slug ?? "").trim(),
        displayName: String(model.display_name ?? model.slug ?? "").trim(),
        description: String(model.description ?? "").trim(),
        supportedInApi: model.supported_in_api !== false,
        visibility: String(model.visibility ?? "list"),
      }))
      .filter(
        (model) =>
          model.slug && model.supportedInApi && model.visibility !== "hide",
      );
  } catch {
    return CODEX_MODEL
      ? [
          {
            slug: CODEX_MODEL,
            displayName: CODEX_MODEL,
            description: "Active Codex model.",
            supportedInApi: true,
            visibility: "list",
          },
        ]
      : [];
  }
}

async function resolveModel(input: RunAgentInput) {
  const requested = String(
    (input.forwardedProps as Record<string, unknown> | undefined)
      ?.openbotModel ?? "",
  ).trim();
  if (!requested) return CODEX_MODEL;
  const catalog = await loadModelCatalog();
  return catalog.some((model) => model.slug === requested)
    ? requested
    : CODEX_MODEL;
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin");
  const allowedOrigins = new Set([
    "http://localhost:3001",
    "http://localhost:3010",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3010",
  ]);
  return origin && allowedOrigins.has(origin)
    ? { "access-control-allow-origin": origin, vary: "Origin" }
    : {};
}

type RpcMessage = {
  id?: number | string;
  method?: string;
  result?: { thread?: { id?: string }; turn?: { status?: string } };
  error?: { message?: string };
  params?: Record<string, unknown>;
};

type DelegatedToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

class ToolCallDelegated extends Error {
  readonly call: DelegatedToolCall;

  constructor(call: DelegatedToolCall) {
    super("Tool call delegated to the MONOCER surface.");
    this.call = call;
  }
}

function transcript(input: RunAgentInput) {
  return input.messages
    .map((message) => {
      const content = String(message.content ?? "");
      if (
        message.role === "assistant" &&
        "toolCalls" in message &&
        message.toolCalls?.length
      ) {
        const calls = message.toolCalls
          .map((call) => `${call.function.name}(${call.function.arguments})`)
          .join(", ");
        return `ASSISTANT TOOL CALLS: ${calls}${content ? `\n${content}` : ""}`;
      }
      if (message.role === "tool" && "toolCallId" in message) {
        return `TOOL RESULT [${message.toolCallId}]: ${content}`;
      }
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
}

function sendRpc(stdin: Bun.FileSink, message: unknown) {
  return stdin.write(`${JSON.stringify(message)}\n`);
}

async function runCodexOnce(
  prompt: string,
  model: string | undefined,
  inputTools: Array<{
    type: "function";
    name: string;
    description: string;
    inputSchema: unknown;
  }>,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
) {
  const child = Bun.spawn([CODEX_EXECUTABLE, "app-server", "--stdio"], {
    cwd: WORKDIR,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const writer = child.stdin;
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let threadId = "";
  let requestId = 1;
  let completed = false;
  let finalError: string | undefined;
  const abortChild = () => child.kill();
  signal?.addEventListener("abort", abortChild, { once: true });

  const waitFor = async (id: number) => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return id === -1 ? undefined : undefined;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: RpcMessage;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          continue;
        }
        if (message.method === "item/agentMessage/delta") {
          const delta = String(message.params?.delta ?? "");
          if (delta) onDelta(delta);
        }
        if (message.method === "item/tool/call") {
          const params = message.params ?? {};
          const callId = String(params.callId ?? "");
          const name = String(params.tool ?? "");
          if (callId && name) {
            // The MONOCER surface owns client-provided tools such as computer_* actions. The
            // app-server request must still be answered so Codex can release the turn; the actual
            // AG-UI tool call is emitted below and the surface starts the continuation run with the
            // tool result.
            if (message.id !== undefined) {
              await sendRpc(writer, {
                id: message.id,
                result: {
                  success: false,
                  contentItems: [
                    {
                      type: "inputText",
                      text: "The MONOCER surface will execute this tool call. End this turn now.",
                    },
                  ],
                },
              });
            }
            throw new ToolCallDelegated({
              id: callId,
              name,
              arguments: params.arguments ?? {},
            });
          }
        }
        if (message.method === "turn/completed") {
          completed = true;
          const status = (
            message.params?.turn as { status?: string } | undefined
          )?.status;
          if (status && status !== "completed")
            finalError = `Codex turn ended with status: ${status}`;
          if (id === -1) return message;
        }
        if (message.id === id) return message;
        if (message.error)
          finalError = message.error.message ?? "Codex app-server error";
      }
    }
    return undefined;
  };

  try {
    if (signal?.aborted) throw new Error("Codex turn cancelled.");
    const initializeId = requestId++;
    await sendRpc(writer, {
      method: "initialize",
      id: initializeId,
      params: {
        clientInfo: { name: "monocer-openbot", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });
    const initialized = await waitFor(initializeId);
    if (!initialized?.result)
      throw new Error(
        initialized?.error?.message ?? "Codex initialization failed",
      );
    await sendRpc(writer, { method: "initialized", params: {} });

    const threadRequestId = requestId++;
    await sendRpc(writer, {
      method: "thread/start",
      id: threadRequestId,
      params: {
        cwd: WORKDIR,
        model,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        dynamicTools: inputTools,
        baseInstructions:
          "You are the Codex-powered MONOCER agency assistant. Be practical, concise, and honest about what you can do. Do not claim browser or computer actions unless you have actually completed them.",
      },
    });
    const threadResponse = await waitFor(threadRequestId);
    threadId = String(threadResponse?.result?.thread?.id ?? "");
    if (!threadId)
      throw new Error(
        threadResponse?.error?.message ?? "Codex did not create a thread",
      );

    const turnRequestId = requestId++;
    await sendRpc(writer, {
      method: "turn/start",
      id: turnRequestId,
      params: {
        threadId,
        input: [{ type: "text", text: prompt }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    });
    const turnResponse = await waitFor(turnRequestId);
    if (turnResponse?.error)
      throw new Error(turnResponse.error.message ?? "Codex turn failed");
    while (!completed && !finalError) {
      await waitFor(-1);
      if (!completed && !finalError) {
        throw new Error("Codex ended before completing the turn.");
      }
    }
    if (finalError) throw new Error(finalError);
  } finally {
    signal?.removeEventListener("abort", abortChild);
    try {
      writer.end();
    } catch {}
    child.kill();
    await child.exited;
  }
}

/**
 * Recover one transient app-server startup/transport failure, but never replay a turn after it has
 * started producing an answer or delegated a tool. Replaying after either point could duplicate a
 * visible answer or a real computer action.
 */
async function runCodex(
  prompt: string,
  model: string | undefined,
  inputTools: Array<{
    type: "function";
    name: string;
    description: string;
    inputSchema: unknown;
  }>,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
) {
  let emitted = false;
  const forward = (delta: string) => {
    emitted = true;
    onDelta(delta);
  };
  try {
    return await runCodexOnce(prompt, model, inputTools, forward, signal);
  } catch (error) {
    if (signal?.aborted || error instanceof ToolCallDelegated || emitted)
      throw error;
    // A signed-in desktop catalog can briefly advertise a model before the local app-server
    // understands it. Keep the per-channel choice useful without turning that transient mismatch
    // into a dead conversation: retry once on the configured default, but never replay after any
    // visible answer or delegated computer action.
    if (model && model !== CODEX_MODEL) {
      return runCodexOnce(prompt, CODEX_MODEL, inputTools, onDelta, signal);
    }
    return runCodexOnce(prompt, model, inputTools, onDelta, signal);
  }
}

async function runAgent(
  input: RunAgentInput,
  signal?: AbortSignal,
): Promise<Response> {
  const encoder = new EventEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      const send = (event: BaseEvent) =>
        controller.enqueue(utf8.encode(encoder.encodeSSE(event)));
      const messageId = `msg_${input.runId}`;
      let textStarted = false;
      send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      try {
        const prompt = [
          "You are the Codex-powered MONOCER agency assistant.",
          "Use the conversation below as the user's current request and context.",
          "If the conversation contains a TOOL RESULT, treat it as the result of a tool already executed by the MONOCER surface. Do not repeat that tool call unless the result explicitly says it failed or asks for a retry.",
          transcript(input),
        ].join("\n\n");
        await runCodex(
          prompt,
          await resolveModel(input),
          input.tools.map((tool) => ({
            type: "function" as const,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
          (delta) => {
            if (!textStarted) {
              send({
                type: "TEXT_MESSAGE_START",
                messageId,
                role: "assistant",
              } as BaseEvent);
              textStarted = true;
            }
            send({
              type: "TEXT_MESSAGE_CONTENT",
              messageId,
              delta,
            } as BaseEvent);
          },
          signal,
        );
        if (textStarted)
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        send({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
      } catch (error) {
        if (error instanceof ToolCallDelegated) {
          if (textStarted)
            send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
          send({
            type: "TOOL_CALL_START",
            toolCallId: error.call.id,
            toolCallName: error.call.name,
            parentMessageId: messageId,
          } as BaseEvent);
          send({
            type: "TOOL_CALL_ARGS",
            toolCallId: error.call.id,
            delta: JSON.stringify(error.call.arguments ?? {}),
          } as BaseEvent);
          send({
            type: "TOOL_CALL_END",
            toolCallId: error.call.id,
          } as BaseEvent);
          send({
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          return;
        }
        if (textStarted)
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        send({
          type: "RUN_ERROR",
          message:
            error instanceof Error ? error.message : "Codex could not answer.",
        } as BaseEvent);
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          model: CODEX_MODEL ?? "configured",
          auth: "codex-chatgpt",
        }),
        {
          headers: {
            "content-type": "application/json",
            ...corsHeaders(request),
          },
        },
      );
    }
    if (url.pathname === "/models") {
      const models = await loadModelCatalog();
      return new Response(
        JSON.stringify({ activeModel: CODEX_MODEL ?? null, models }),
        {
          headers: {
            "content-type": "application/json",
            ...corsHeaders(request),
          },
        },
      );
    }
    if (url.pathname === "/ag-ui" && request.method === "POST") {
      if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN))
        return Response.json({ error: "Unauthorized." }, { status: 401 });
      return runAgent((await request.json()) as RunAgentInput, request.signal);
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.info(`Codex AG-UI bridge listening on http://127.0.0.1:${PORT}/ag-ui`);
