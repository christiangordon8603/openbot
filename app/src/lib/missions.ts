export type MissionResult = {
  agentId: string;
  status: "succeeded" | "failed";
  output?: string;
  error?: string;
};

export type Mission = {
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

const endpoint = () => {
  const configured = import.meta.env.VITE_ROUTINES_URL as string | undefined;
  return configured?.trim() || "http://127.0.0.1:4400";
};

export const missionKeys = { all: ["missions"] as const };

export async function listMissions(): Promise<{ missions: Mission[] }> {
  const response = await fetch(`${endpoint()}/missions`);
  if (!response.ok) throw new Error("Could not load missions.");
  return response.json() as Promise<{ missions: Mission[] }>;
}

export async function createMission(input: {
  task: string;
  agentIds: string[];
  synthesisAgentId: string;
}): Promise<{ mission: Mission }> {
  const response = await fetch(`${endpoint()}/missions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as { mission?: Mission; error?: string };
  if (!response.ok || !body.mission) throw new Error(body.error || "Could not start mission.");
  return { mission: body.mission };
}
