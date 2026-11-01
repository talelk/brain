import { GovernorError } from "../../data/client";
import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "@talelk/newui-atoms";
import type { IncidentSummary, SLASummary, TicketSummary } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import type { ScreenState } from "../../data/screens";
import { incidentsQuery, slaQuery, ticketsQuery } from "../../data/governor";
import { DateText, isFreshFromServer, ScreenRegion } from "../../ui/screen-region";
import { ThemeToggle } from "../../ui/components/ThemeToggle";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { formatSlaMinutes } from "../../ui/format";

export function useDetailWorkspace(): () => string {
  const app = useApp();
  return () => app.workspaceId() || app.identity()?.workspaces[0]?.workspaceId || "";
}

export function monthPeriod(): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { periodStart: periodStart.toISOString(), periodEnd: now.toISOString() };
}

function connectionLabel(state: ScreenState<unknown>): { label: string; theme: "green" | "amber" | "red" | "gray" } {
  if (state.status === "ready" || state.status === "empty-authorized") return { label: "Live authorized data", theme: "green" };
  if (state.status === "loading") return { label: "Connecting", theme: "gray" };
  if (state.status === "partial-failure" || state.status === "stale") return { label: "Partial / stale data", theme: "amber" };
  return { label: "Connection unavailable", theme: "red" };
}

function KioskHeader(props: { area: "support" | "sre"; state: ScreenState<unknown>; asOf?: string }): JSX.Element {
  const connection = () => connectionLabel(props.state);
  return <header class="flex flex-wrap items-center justify-between gap-5 border-b-2 border-outline-gray-2 pb-6">
    <div class="flex items-center gap-4"><span class="grid size-14 place-items-center rounded-card bg-surface-blue-9 text-heading font-semibold text-white">B</span><div><h1 class="text-[clamp(1.75rem,2.2vw,2.75rem)] font-semibold leading-tight tracking-tight">Keyrus Brain <span class="text-ink-gray-6">/ {props.area === "support" ? "Support" : "SRE"}</span></h1><p class="mt-1 text-base text-ink-gray-6 md:text-lg">Read-only redacted operations wallboard</p></div></div>
    <div class="flex flex-wrap items-center gap-4"><div class="text-end"><Badge size="lg" theme={connection().theme} label={connection().label} /><p class="mt-2 text-sm text-ink-gray-6 md:text-base">Last authorized update <DateText value={props.asOf} /></p></div><ThemeToggle /></div>
  </header>;
}

function WallStat(props: { label: string; value: string; hint: string; tone?: "red" | "amber" | "blue" | "gray" }): JSX.Element {
  return <div class={`rounded-card border-s-4 bg-surface-elevation-1 p-5 md:p-6 ${props.tone === "red" ? "border-s-outline-red-5" : props.tone === "amber" ? "border-s-outline-amber-5" : props.tone === "blue" ? "border-s-outline-blue-5" : "border-s-outline-gray-3"}`}><p class="text-base text-ink-gray-6 md:text-lg">{props.label}</p><p class="mt-2 text-3xl font-semibold tabular-nums tracking-tight md:text-4xl">{props.value}</p><p class="mt-2 text-sm text-ink-gray-6 md:text-base">{props.hint}</p></div>;
}

export function TvBoard(props: { area: "support" | "sre" }): JSX.Element {
  const app = useApp();
  const support = createScopedRead<{ tickets: TicketSummary[]; sla?: SLASummary }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const period = monthPeriod();
      const [tickets, sla] = await Promise.all([
        ticketsQuery(scope.workspaceId, signal),
        slaQuery(scope.workspaceId, period.periodStart, period.periodEnd, signal).catch((error: unknown) => { if (error instanceof GovernorError && (error.status === 401 || error.status === 403)) throw error; return undefined; }),
      ]);
      return { asOf: tickets.asOf, sourceWatermark: tickets.sourceWatermark, partialFailures: sla ? [] : ["SLA summary is unavailable"], snapshot: { tickets: [...tickets.snapshot.items], sla: sla?.snapshot } };
    },
    isEmpty: (data) => data.tickets.length === 0, refreshMs: 20_000,
  });
  const incidents = createScopedRead<IncidentSummary[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await incidentsQuery(scope.workspaceId, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0, refreshMs: 20_000,
  });
  const tickets = () => [...(support.state().data?.tickets ?? [])].sort((a, b) => {
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
    return rank[a.priority] - rank[b.priority] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
  const incidentRows = () => [...(incidents.state().data ?? [])].sort((a, b) => Number(a.severity !== "critical") - Number(b.severity !== "critical") || Date.parse(b.observedAt) - Date.parse(a.observedAt));
  return <main data-testid="tv-kiosk" class="brain-wallboard p-5 md:p-8 2xl:p-10">
    <div class="mx-auto flex max-w-[1800px] flex-col gap-6 md:gap-8">
      <KioskHeader area={props.area} state={props.area === "support" ? support.state() : incidents.state()} asOf={props.area === "support" ? support.state().asOf : incidents.state().asOf} />
      <Show when={props.area === "support"} fallback={<ScreenRegion state={incidents.state()} skeleton="rows" emptyTitle="No open incidents returned" emptyDescription="The authorized incident query returned no open records. This is not proof that every target is healthy." onRetry={() => void incidents.refresh({ force: true })}>
          <Show when={incidentRows()[0]} keyed>{(incident) => <section aria-label="Highest severity incident" class={`rounded-card border-s-8 p-6 md:p-8 ${incident.severity === "critical" ? "border-s-outline-red-6 bg-surface-red-1" : "border-s-outline-amber-5 bg-surface-amber-1"}`}>
            <div class="flex flex-wrap items-center gap-3"><StatusBadge kind="severity" status={incident.severity} /><StatusBadge kind="incident" status={incident.state} /><Show when={!isFreshFromServer(incident.expiresAt, incidents.state().asOf)}><Badge size="lg" theme="amber" label="Stale observation" /></Show></div>
            <h2 class="mt-4 text-3xl font-semibold tracking-tight md:text-5xl">{incident.title}</h2><p class="mt-3 text-xl text-ink-gray-8 md:text-2xl">{incident.targetKey}</p>
            <div class="mt-6 flex flex-wrap gap-x-8 gap-y-2 text-base text-ink-gray-7 md:text-lg"><span>Observed <DateText value={incident.observedAt} /></span><span>Valid until <DateText value={incident.expiresAt} /></span></div>
          </section>}</Show>
          <section aria-label="Other observed incidents"><h2 class="mb-3 text-xl font-semibold md:text-2xl">Observed incident queue</h2><div class="grid gap-4 lg:grid-cols-2"><For each={incidentRows().slice(1)}>{(incident) => <article class="rounded-card border border-outline-gray-2 bg-surface-elevation-1 p-5"><div class="flex flex-wrap items-center gap-2"><StatusBadge kind="severity" status={incident.severity} /><Show when={!isFreshFromServer(incident.expiresAt, incidents.state().asOf)}><Badge theme="amber" label="Stale" /></Show></div><h3 class="mt-3 text-xl font-medium md:text-2xl">{incident.title}</h3><p class="mt-2 text-base text-ink-gray-7 md:text-lg">{incident.targetKey}</p><p class="mt-3 text-sm text-ink-gray-6 md:text-base">Observed <DateText value={incident.observedAt} /></p></article>}</For></div></section>
        </ScreenRegion>}>
        <div class="grid gap-4 md:grid-cols-3"><WallStat label="Urgent / high priority" value={String(tickets().filter((ticket) => ticket.priority === "urgent" || ticket.priority === "high").length)} hint="Open exceptions in the authorized queue" tone={tickets().some((ticket) => ticket.priority === "urgent") ? "red" : "amber"} /><WallStat label="Awaiting review evidence" value={String(tickets().filter((ticket) => !ticket.evidenceReady).length)} hint="Drafts not ready for publication review" tone="blue" /><WallStat label="Measured SLA samples" value={String(support.state().data?.sla?.sampleCount ?? 0)} hint={support.state().data?.sla ? `${support.state().data?.sla?.responseMet} responses met · ${support.state().data?.sla?.resolutionMet} resolutions met` : "SLA summary unavailable"} tone="gray" /></div>
        <Show when={support.state().data?.sla} keyed>{(sla) => <div class="flex flex-wrap gap-x-8 gap-y-2 text-base text-ink-gray-7 md:text-lg"><span>Keyrus response <strong>{formatSlaMinutes(sla.keyrusMs)}</strong></span><span>Client wait <strong>{formatSlaMinutes(sla.clientWaitMs)}</strong></span><span>Incomplete records <strong>{sla.incompleteRecords}</strong></span></div>}</Show>
        <section aria-label="Support exception queue"><div class="mb-4"><h2 class="text-2xl font-semibold md:text-3xl">Support exceptions</h2><p class="mt-1 text-base text-ink-gray-6 md:text-lg">Priority, state and draft evidence—never customer bodies on the wallboard.</p></div>
          <ScreenRegion state={support.state()} skeleton="rows" emptyTitle="No support tickets returned" emptyDescription="The authorized queue returned no records. Connection state and last update remain visible above." onRetry={() => void support.refresh({ force: true })}>
            <div class="grid gap-4 xl:grid-cols-2"><For each={tickets()}>{(ticket) => <article class={`rounded-card border-s-4 bg-surface-elevation-1 p-5 md:p-6 ${ticket.priority === "urgent" ? "border-s-outline-red-5" : ticket.priority === "high" ? "border-s-outline-amber-5" : "border-s-outline-blue-4"}`}>
              <div class="flex flex-wrap items-center gap-2"><StatusBadge kind="ticket" status={ticket.state} /><StatusBadge kind="severity" status={ticket.priority} /><Badge size="lg" variant="outline" theme={ticket.evidenceReady ? "green" : "amber"} label={ticket.evidenceReady ? "Evidence ready" : "Evidence pending"} /></div>
              <h3 class="mt-3 text-xl font-medium leading-snug md:text-2xl">{ticket.title}</h3><p class="mt-3 text-sm text-ink-gray-6 md:text-base">Updated <DateText value={ticket.updatedAt} /></p>
            </article>}</For></div>
          </ScreenRegion>
        </section>
      </Show>
    </div>
  </main>;
}
