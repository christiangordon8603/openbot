import { IconBolt, IconPlayerPlay } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { createMission, missionKeys, listMissions } from "@/lib/missions";

export const Route = createFileRoute("/_authed/_app/missions")({ component: MissionsPage });

function MissionsPage() {
  const queryClient = useQueryClient();
  const agents = useQuery(agentListQueryOptions());
  const missions = useQuery({ queryKey: missionKeys.all, queryFn: listMissions, refetchInterval: 3000 });
  const [task, setTask] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [lead, setLead] = useState("");
  const [allowLeadTools, setAllowLeadTools] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agents.data?.length || selected.length > 0) return;
    const ids = agents.data.slice(0, 7).map((agent) => agent.id);
    setSelected(ids);
    setLead(ids[0] ?? "");
  }, [agents.data, selected.length]);

  const start = useMutation({
    mutationFn: createMission,
    onSuccess: () => {
      setTask("");
      setAllowLeadTools(false);
      void queryClient.invalidateQueries({ queryKey: missionKeys.all });
    },
    onError: (caught: Error) => setError(caught.message),
  });

  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return <div className="min-h-full overflow-y-auto"><div className="mx-auto w-full max-w-5xl px-5 pb-16 pt-8 sm:px-8 lg:px-10">
    <div><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground"><IconBolt className="size-4" />MONOCER / MISSIONS</div><h1 className="mt-4 text-4xl font-semibold tracking-tight">Run the whole agency.</h1><p className="mt-3 max-w-2xl text-muted-foreground">Fan one brief out to specialist lanes, then have a lead lane synthesize the findings into a single direction. Parallel passes are analysis-only so browser workers never fight over one screen.</p></div>
    {error ? <p className="mt-5 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</p> : null}
    <form className="mt-8 grid gap-5 rounded-3xl border border-border/70 bg-card p-5 shadow-sm sm:p-7" onSubmit={(event) => { event.preventDefault(); setError(null); start.mutate({ task, agentIds: selected, synthesisAgentId: lead, allowLeadTools }); }}>
      <div><label className="text-sm font-medium" htmlFor="mission-task">Mission brief</label><textarea id="mission-task" className="mt-2 min-h-32 w-full rounded-xl border bg-background px-3 py-2.5" required value={task} onChange={(event) => setTask(event.target.value)} placeholder="Build a launch recommendation for a new premium skincare client." /></div>
      <div><p className="text-sm font-medium">Specialist lanes</p><div className="mt-3 grid gap-2 sm:grid-cols-2">{(agents.data ?? []).slice(0, 7).map((agent) => <label key={agent.id} className="flex items-start gap-3 rounded-xl border p-3 text-sm"><input type="checkbox" className="mt-0.5" checked={selected.includes(agent.id)} onChange={() => toggle(agent.id)} /><span><span className="font-medium">{agent.name}</span><span className="mt-0.5 block text-xs text-muted-foreground">{agent.roleDescription}</span></span></label>)}</div></div>
      <div><label className="text-sm font-medium" htmlFor="mission-lead">Lead lane</label><select id="mission-lead" className="mt-2 w-full rounded-xl border bg-background px-3 py-2.5" required value={lead} onChange={(event) => setLead(event.target.value)}>{(agents.data ?? []).filter((agent) => selected.includes(agent.id)).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div>
      <label className="flex items-start gap-3 rounded-xl border p-3 text-sm"><input type="checkbox" className="mt-0.5" checked={allowLeadTools} onChange={(event) => setAllowLeadTools(event.target.checked)} /><span><span className="font-medium">Let the lead lane act</span><span className="mt-0.5 block text-xs text-muted-foreground">After synthesis, the lead may use the assigned MONOCER browser and computer to complete the brief.</span></span></label>
      <div className="flex justify-end"><button type="submit" disabled={start.isPending || selected.length === 0} className="inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-sm font-medium text-background"><IconPlayerPlay className="size-4" />{start.isPending ? "Starting…" : "Start mission"}</button></div>
    </form>
    <div className="mt-8 space-y-4">{missions.isPending ? <p className="text-sm text-muted-foreground">Loading missions…</p> : (missions.data?.missions ?? []).slice().reverse().map((mission) => <article key={mission.id} className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm"><div className="flex flex-wrap items-center gap-2"><span className={`size-2 rounded-full ${mission.status === "succeeded" ? "bg-emerald-400" : mission.status === "running" ? "bg-amber-400" : "bg-red-400"}`} /><span className="rounded-full bg-muted px-3 py-1 text-xs">{mission.status}</span><span className="text-xs text-muted-foreground">{mission.agentIds.length} lanes · lead {mission.synthesisAgentId}{mission.allowLeadTools ? " · actions enabled" : ""}</span></div><p className="mt-3 text-sm font-medium">{mission.task}</p>{mission.synthesis ? <div className="mt-4 whitespace-pre-wrap rounded-xl bg-muted/60 p-4 text-sm">{mission.synthesis}</div> : <p className="mt-4 text-xs text-muted-foreground">Specialists are working…</p>}<div className="mt-4 flex flex-wrap gap-2">{mission.results.map((result) => <span key={result.agentId} className="rounded-full border px-3 py-1 text-xs">{result.agentId}: {result.status}</span>)}</div></article>)}</div>
    {!missions.isPending && (missions.data?.missions ?? []).length === 0 ? <div className="mt-8 rounded-3xl border border-dashed p-10 text-center"><IconBolt className="mx-auto size-6 text-muted-foreground" /><p className="mt-3 font-medium">No missions yet.</p><p className="mt-1 text-sm text-muted-foreground">Give the agency a brief to start a coordinated pass.</p></div> : null}
  </div></div>;
}
