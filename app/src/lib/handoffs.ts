import { queryOptions } from "@tanstack/react-query";

const ROUTINES_URL = import.meta.env.VITE_ROUTINES_URL ?? "http://127.0.0.1:4400";

export type Handoff = {
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ROUTINES_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "The handoff service did not respond.");
  return body;
}
export const handoffKeys = { all: ["handoffs"] as const };

export function handoffsQueryOptions() {
  return queryOptions({
    queryKey: handoffKeys.all,
    queryFn: () => request<{ handoffs: Handoff[] }>("/handoffs"),
    refetchInterval: 5_000,
  });
}

export function createHandoff(input: { fromAgentId: string; toAgentId: string; task: string; context?: string }) {
  return request<{ handoff: Handoff }>("/handoffs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
