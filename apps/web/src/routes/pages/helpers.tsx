import { GovernorError } from "../../data/client";
import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "@talelk/newui-atoms";
import { DataTable, Section, StatGrid } from "@talelk/newui-organisms";
import type { IncidentSummary, SLASummary, TicketSummary } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { incidentsQuery, slaQuery, ticketsQuery } from "../../data/governor";
import { ScreenRegion, DateText } from "../../ui/screen-region";
import { ThemeToggle } from "../../ui/components/ThemeToggle";
import { StatusBadge } from "../../ui/components/StatusBadge";
import { formatDateTime, formatSlaMinutes } from "../../ui/format";
import { CardTile } from "../../ui/components/primitives";

export function useDetailWorkspace(): () => string {
  const app = useApp();
  return () => app.workspaceId() || app.identity()?.workspaces[0]?.workspaceId || "";
}

export function monthPeriod(): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { periodStart: periodStart.toISOString(), periodEnd: now.toISOString() };
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
  return <main data-testid="tv-kiosk" class="min-h-dvh bg-surface-gray-1 p-page-gutter text-ink-gray-9 md:p-page-gutter-wide">
    <div class="mx-auto flex max-w-[1600px] flex-col gap-section-gap">
      <header class="flex flex-wrap items-center justify-between gap-4 border-b border-outline-gray-1 pb-5">
        <div class="flex items-center gap-3"><span class="grid size-11 place-items-center rounded-card bg-surface-blue-9 text-heading font-semibold text-white">B</span><div><h1 class="text-hero">Keyrus Brain — {props.area === "support" ? "Support board" : "SRE board"}</h1><p class="text-interface text-ink-gray-6">Read-only redacted view</p></div></div>
        <div class="flex items-center gap-3"><Badge theme="green" label="Auto-refreshing" /><ThemeToggle /></div>
      </header>
      <Show when={props.area === "support"} fallback={<PageStackTv>
        <Section title="Open incidents" description="Current severity and observation freshness." surface="card">
          <ScreenRegion state={incidents.state()} skeleton="rows" emptyTitle="No open incidents" emptyDescription="Monitored targets are not reporting breaches." onRetry={() => void incidents.refresh({ force: true })}>
            <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3"><For each={incidents.state().data ?? []}>{(incident) => <CardTile wide><StatusBadge kind="severity" status={incident.severity} /><h2 class="mt-3 text-section">{incident.title}</h2><p class="mt-2 text-interface text-ink-gray-7">{incident.targetKey}</p><p class="mt-3 text-caption text-ink-gray-6">Observed <DateText value={incident.observedAt} /><br />Expires <DateText value={incident.expiresAt} /></p></CardTile>}</For></div>
          </ScreenRegion>
        </Section>
      </PageStackTv>}>
        <PageStackTv>
          <Show when={support.state().data?.sla} keyed>{(sla) => <StatGrid columns={3} stats={[
            { label: "Keyrus response", value: formatSlaMinutes(sla.keyrusMs), icon: "lucide-timer" }, { label: "Client wait", value: formatSlaMinutes(sla.clientWaitMs), icon: "lucide-clock" }, { label: "Samples", value: String(sla.sampleCount), icon: "lucide-chart-no-axes-column" },
          ]} />}</Show>
          <Section title="Support queue" description="Redacted ticket state and review readiness." surface="card">
            <ScreenRegion state={support.state()} skeleton="rows" emptyTitle="No support tickets" emptyDescription="The current support queue is clear." onRetry={() => void support.refresh({ force: true })}>
              <DataTable title="Support board" selectable={false} hideSearch cardBreakpoint="lg" rows={support.state().data?.tickets ?? []} columns={[
                { id: "title", header: "Ticket", accessorKey: "title", meta: { mobile: "title" } },
                { id: "state", header: "State", accessorKey: "state", meta: { mobile: "status" }, cell: (context) => <StatusBadge kind="ticket" status={context.row.original.state} /> },
                { id: "priority", header: "Priority", accessorKey: "priority", meta: { mobile: "meta" } },
                { id: "evidence", header: "Draft evidence", accessorFn: (row) => row.evidenceReady ? "Ready" : "Pending", meta: { mobile: "meta" } },
                { id: "updated", header: "Updated", accessorFn: (row) => formatDateTime(row.updatedAt), meta: { mobile: "subtitle" } },
              ]} />
            </ScreenRegion>
          </Section>
        </PageStackTv>
      </Show>
    </div>
  </main>;
}

function PageStackTv(props: { children: JSX.Element }): JSX.Element {
  return <div class="flex min-w-0 flex-col gap-section-gap">{props.children}</div>;
}
