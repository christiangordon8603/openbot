import {
  IconActivity,
  IconArrowUpRight,
  IconBolt,
  IconBrain,
  IconBrowser,
  IconChevronRight,
  IconCircleCheck,
  IconClock,
  IconLayoutDashboard,
  IconDeviceDesktop,
  IconPlus,
  IconSparkles,
  IconUsers,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Composer, toAgentOptions } from "@/components/channels/composer";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { routeMessage } from "@/lib/channels/route";
import { useStartChannel } from "@/lib/channels/start";

export const Route = createFileRoute("/_authed/_app/")({ component: MonocerDashboard });

const agencyRoles = [
  ["Strategy", "Briefs, positioning, and growth decisions", "bg-amber-400", "strategy"],
  ["Creative", "Concepts, copy, and visual direction", "bg-fuchsia-400", "creative"],
  ["Production", "Plans, vendors, and delivery systems", "bg-cyan-400", "production"],
  ["Research", "Signals, sources, and market intelligence", "bg-lime-400", "research"],
  ["Accounts", "Client context, status, and next actions", "bg-orange-400", "accounts"],
  ["Operations", "Routines, QA, and agency infrastructure", "bg-violet-400", "operations"],
  ["Studio", "Experiments, prototypes, and new tools", "bg-rose-400", "studio"],
] as const;

const agencyLaneIds = new Set([
  "strategy",
  "creative",
  "production",
  "research",
  "accounts",
  "operations",
  "studio",
]);

function StatusDot({ live = true }: { live?: boolean }) {
  return <span className={`inline-block size-2 rounded-full ${live ? "bg-emerald-400" : "bg-muted-foreground/30"}`} />;
}

function StatCard({ icon: Icon, label, value, note }: { icon: typeof IconActivity; label: string; value: string; note: string }) {
  return <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm"><div className="flex items-center justify-between text-muted-foreground"><span className="text-xs font-medium uppercase tracking-[0.16em]">{label}</span><Icon className="size-4" /></div><div className="mt-3 text-3xl font-semibold tracking-tight">{value}</div><div className="mt-1 text-xs text-muted-foreground">{note}</div></div>;
}

function MonocerDashboard() {
  const { data: agents } = useQuery(agentListQueryOptions());
  const { data: channels = [] } = useInfiniteQuery(channelListQueryOptions());
  const { start, pending } = useStartChannel();
  const [error, setError] = useState<string | null>(null);
  const fallback = agents?.[0];
  const agencyAgents = agents
    ? [...agencyLaneIds]
        .map((id) => agents.find((agent) => agent.id === id))
        .filter((agent): agent is (typeof agents)[number] => agent !== undefined)
    : [];
  const liveAgents = agencyAgents.filter((agent) => agent.endpoint || agent.systemOwned).length;
  const recentChannels = channels?.slice(0, 4) ?? [];

  return <div className="min-h-full overflow-y-auto bg-[radial-gradient(circle_at_top_right,rgba(244,114,182,0.10),transparent_32%),radial-gradient(circle_at_20%_0%,rgba(34,211,238,0.08),transparent_28%)]"><div className="mx-auto w-full max-w-7xl px-5 pb-16 pt-8 sm:px-8 lg:px-10">
    <header className="flex flex-wrap items-start justify-between gap-5"><div><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground"><span className="inline-flex size-7 items-center justify-center rounded-lg bg-foreground text-background"><IconSparkles className="size-4" /></span>MONOCER / OPERATIONS</div><h1 className="mt-5 max-w-3xl text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">The agency, in motion.</h1><p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">A single operating surface for your Claude-built agency team, browser workers, and the work that moves MONOCER forward.</p></div><div className="flex items-center gap-2 rounded-full border border-border/80 bg-card/80 px-3 py-2 text-xs text-muted-foreground shadow-sm"><StatusDot />Local system online</div></header>

    <section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><StatCard icon={IconUsers} label="Agency lanes" value={`${agencyAgents.length}`} note="Claude roles ready to connect" /><StatCard icon={IconActivity} label="Active threads" value={`${channels?.length ?? 0}`} note="Persistent conversations" /><StatCard icon={IconBrowser} label="Browser workers" value={`${agencyAgents.length}`} note="Isolated Linux computers online" /><StatCard icon={IconBrain} label="Model layer" value="Claude" note="Signed-in Claude Pro · Sonnet" /></section>

    <section className="mt-8 rounded-3xl border border-border/70 bg-card p-5 shadow-sm sm:p-6"><div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-start gap-3"><span className="flex size-10 items-center justify-center rounded-2xl bg-muted"><IconDeviceDesktop className="size-5" /></span><div><div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Dedicated workstation</div><h2 className="mt-1 text-xl font-semibold tracking-tight">MONOCER Linux Computer</h2><p className="mt-1 text-sm text-muted-foreground">A persistent local desktop for files, browser sessions, and agent-assisted work.</p></div></div><a className="inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2.5 text-sm font-medium text-background transition hover:opacity-85" href="http://127.0.0.1:6080" target="_blank" rel="noreferrer">Open computer <IconArrowUpRight className="size-4" /></a></div><div className="mt-4 flex flex-wrap gap-2 text-xs text-muted-foreground"><span className="rounded-full bg-muted px-3 py-1.5">Linux · persistent</span><span className="rounded-full bg-muted px-3 py-1.5">Local-only access</span><span className="rounded-full bg-muted px-3 py-1.5">Per-agent computers managed below</span></div></section>

    <section className="mt-8 grid gap-6 xl:grid-cols-[1.25fr_0.75fr]"><div className="rounded-3xl border border-border/70 bg-card p-5 shadow-sm sm:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground"><IconLayoutDashboard className="size-4" />Command desk</div><h2 className="mt-2 text-2xl font-semibold tracking-tight">Give the studio a direction</h2></div><Link className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" to="/agents">Manage agents <IconArrowUpRight className="size-4" /></Link></div><div className="mt-6 rounded-2xl border border-border/70 bg-background/70 p-3"><Composer agents={toAgentOptions(agents)} className="w-full" disabled={!fallback} pending={pending} onSubmit={async (draft) => { setError(null); try { const agentId = draft.agentId ?? (await routeMessage(draft.text)).agentId; if (agentId) await start(agentId, draft.text); } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not start this direction."); } }} />{error ? <p className="mt-2 text-sm text-destructive" role="alert">{error}</p> : null}</div><div className="mt-5 flex flex-wrap gap-2 text-xs text-muted-foreground"><span className="rounded-full bg-muted px-3 py-1.5">Ask for a brief</span><span className="rounded-full bg-muted px-3 py-1.5">Research a market</span><span className="rounded-full bg-muted px-3 py-1.5">Review a concept</span><span className="rounded-full bg-muted px-3 py-1.5">Plan production</span></div></div><div className="rounded-3xl bg-foreground p-6 text-background shadow-sm sm:p-7"><div className="flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-[0.18em] text-background/60">System pulse</span><IconBolt className="size-5 text-amber-300" /></div><div className="mt-12 text-5xl font-semibold tracking-[-0.06em]">{liveAgents}<span className="text-background/40">/{agents?.length ?? 0}</span></div><p className="mt-2 text-sm text-background/65">agents are ready to receive work</p><div className="mt-8 space-y-3 border-t border-background/15 pt-5 text-sm"><div className="flex items-center justify-between"><span className="flex items-center gap-2"><StatusDot />Browser computers</span><span className="text-background/60">ready</span></div><div className="flex items-center justify-between"><span className="flex items-center gap-2"><StatusDot />Claude model</span><span className="text-background/60">ready</span></div><div className="flex items-center justify-between"><span className="flex items-center gap-2"><StatusDot />Memory layer</span><span className="text-background/60">connected</span></div></div></div></section>

    <section className="mt-8 grid gap-6 xl:grid-cols-[1fr_0.9fr]"><div><div className="flex items-end justify-between"><div><div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Your operating system</div><h2 className="mt-2 text-2xl font-semibold tracking-tight">Seven agency lanes</h2></div><Link className="text-sm text-muted-foreground hover:text-foreground" to="/agents">Open roster <IconChevronRight className="inline size-4" /></Link></div><div className="mt-4 grid gap-3 sm:grid-cols-2">{agencyRoles.map(([name, detail, color], index) => { const agent = agents?.[index]; return <Link key={name} to="/agents" search={agent ? { agent: agent.id } : {}} className="group rounded-2xl border border-border/70 bg-card p-4 transition hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-md"><div className="flex items-start justify-between"><span className={`size-3 rounded-full ${color}`} /><IconChevronRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" /></div><div className="mt-7 text-lg font-semibold">{agent?.name ?? name}</div><p className="mt-1 text-sm leading-5 text-muted-foreground">{agent?.roleDescription ?? detail}</p><div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><StatusDot live={!!agent} />{agent ? "Connected to roster" : "Ready to connect"}</div></Link>; })}</div></div><div className="rounded-3xl border border-border/70 bg-card p-5 shadow-sm sm:p-6"><div className="flex items-center justify-between"><div><div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Recent work</div><h2 className="mt-2 text-2xl font-semibold tracking-tight">In the studio</h2></div><IconClock className="size-5 text-muted-foreground" /></div><div className="mt-5 divide-y divide-border/70">{recentChannels.length ? recentChannels.map((channel) => <Link key={channel.id} to="/channel/$channelId" params={{ channelId: channel.id }} className="group flex items-center gap-3 py-4 first:pt-0 last:pb-0"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted"><IconActivity className="size-4 text-muted-foreground" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{channel.name}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{channel.lastMessage ?? "No messages yet"}</span></span><IconChevronRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5" /></Link>) : <div className="py-10 text-center text-sm text-muted-foreground">Your first agency thread will appear here.</div>}</div><Link to="/channel/new" className="mt-5 flex items-center justify-center gap-2 rounded-xl border border-dashed border-border py-3 text-sm font-medium text-muted-foreground transition hover:border-foreground/40 hover:text-foreground"><IconPlus className="size-4" />Start a new thread</Link></div></section>
    <footer className="mt-10 flex items-center gap-2 text-xs text-muted-foreground"><IconCircleCheck className="size-4 text-emerald-500" />MONOCER local prototype · browser actions are isolated and recorded by OpenBot.</footer>
  </div></div>;
}
