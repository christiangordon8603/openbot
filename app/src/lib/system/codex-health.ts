import { queryOptions } from "@tanstack/react-query";

const CODEX_HEALTH_URL =
  import.meta.env.VITE_CODEX_HEALTH_URL ?? "http://127.0.0.1:4203/health";
const CODEX_MODELS_URL = CODEX_HEALTH_URL.replace(/\/health$/, "/models");

export type CodexHealth = {
  status: "ok";
  model: string;
  auth: string;
};

export type CodexModel = {
  slug: string;
  displayName: string;
  description: string;
  supportedInApi: boolean;
  visibility: string;
};

export function codexHealthQueryOptions() {
  return queryOptions({
    queryKey: ["system", "codex-health"],
    queryFn: async () => {
      const response = await fetch(CODEX_HEALTH_URL);
      if (!response.ok) throw new Error("Codex bridge is unavailable.");
      return (await response.json()) as CodexHealth;
    },
    refetchInterval: 15_000,
    retry: 1,
  });
}

export function codexModelsQueryOptions() {
  return queryOptions({
    queryKey: ["system", "codex-models"],
    queryFn: async () => {
      const response = await fetch(CODEX_MODELS_URL);
      if (!response.ok) throw new Error("Codex model catalog is unavailable.");
      return (await response.json()) as { activeModel: string | null; models: CodexModel[] };
    },
    refetchInterval: 60_000,
    retry: 1,
  });
}
