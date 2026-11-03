import { queryOptions } from "@tanstack/react-query";

const ROUTINES_URL =
  import.meta.env.VITE_ROUTINES_URL ?? "http://127.0.0.1:4400";

export type Routine = {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  memory?: Array<{ role: "user" | "assistant"; content: string }>;
};

export type RoutineRun = {
  id: string;
  routineId: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  output?: string;
  error?: string;
};

export type RoutineStore = { routines: Routine[]; runs: RoutineRun[] };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ROUTINES_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "The routine service did not respond.");
  return body;
}
export const routineKeys = { all: ["routines"] as const };

export function routinesQueryOptions() {
  return queryOptions({
    queryKey: routineKeys.all,
    queryFn: () => request<RoutineStore>("/routines"),
    refetchInterval: 10_000,
  });
}

export function createRoutine(input: {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
}) {
  return request<{ routine: Routine }>("/routines", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateRoutine(id: string, input: Partial<Pick<Routine, "enabled" | "intervalMinutes" | "prompt">>) {
  return request<{ routine: Routine }>(`/routines/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function runRoutine(id: string) {
  return request<{ accepted: boolean }>(`/routines/${encodeURIComponent(id)}`, {
    method: "POST",
  });
}

export function deleteRoutine(id: string) {
  return request<{ deleted: boolean }>(`/routines/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
