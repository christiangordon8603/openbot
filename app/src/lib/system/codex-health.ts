import { queryOptions } from "@tanstack/react-query";

const CODEX_HEALTH_URL =
  import.meta.env.VITE_CODEX_HEALTH_URL ?? "http://127.0.0.1:4203/health";

export type CodexHealth = {
  status: "ok";
  model: string;
  auth: string;
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
