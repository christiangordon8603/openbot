import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";

const PORT = Number.parseInt(process.env.PORT ?? "4202", 10);
const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim();
if (!MANAGED_AGENT_TOKEN) throw new Error("MANAGED_AGENT_TOKEN is required");

function transcript(input: RunAgentInput) {
  return input.messages
    .map((message) => {
      const role = message.role.toUpperCase();
      const content = String(message.content ?? "");
      return `${role}: ${content}`;
    })
    .join("\n\n");
}

async function runAgent(input: RunAgentInput): Promise<Response> {
  const encoder = new EventEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      const send = (event: BaseEvent) =>
        controller.enqueue(utf8.encode(encoder.encodeSSE(event)));
      const messageId = `msg_${input.runId}`;

      send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId } as BaseEvent);

      try {
        const prompt = [
          "You are the Claude-powered MONOCER agency assistant.",
          "Answer clearly and practically. Do not claim to have performed browser actions unless the user provides the result.",
          "Conversation:",
          transcript(input),
        ].join("\n\n");
        const child = Bun.spawn(
          [
            "claude",
            "-p",
            prompt,
            "--model",
            process.env.CLAUDE_MODEL ?? "sonnet",
            "--output-format",
            "text",
            "--no-session-persistence",
            "--permission-mode",
            "dontAsk",
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        const exitCode = await child.exited;
        if (exitCode !== 0) {
          // Claude CLI writes account/session state to stdout in some releases and stderr in others.
          // Preserve the useful provider message so a routine or handoff says "session limit" rather
          // than reducing an actionable condition to an opaque exit code.
          throw new Error(
            stderr.trim() || stdout.trim() || `Claude exited with ${exitCode}`,
          );
        }

        send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" } as BaseEvent);
        send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: stdout.trim() } as BaseEvent);
        send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        send({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId } as BaseEvent);
      } catch (error) {
        send({
          type: "RUN_ERROR",
          message: error instanceof Error ? error.message : "Claude could not answer.",
        } as BaseEvent);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": encoder.getContentType(), "cache-control": "no-cache", connection: "keep-alive" },
  });
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ status: "ok", model: process.env.CLAUDE_MODEL ?? "sonnet", auth: "claude.ai" });
    if (url.pathname === "/ag-ui" && request.method === "POST") {
      if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN)) return Response.json({ error: "Unauthorized." }, { status: 401 });
      return runAgent((await request.json()) as RunAgentInput);
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.info(`Claude AG-UI bridge listening on http://127.0.0.1:${PORT}/ag-ui`);
