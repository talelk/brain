import { GovernorError } from "../../data/client";
import { Show } from "solid-js";
import type { JSX } from "solid-js";
import type { IncidentSummary, SLASummary, TicketSummary } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { incidentsQuery, slaQuery, ticketsQuery } from "../../data/governor";
import { SupportScreen, SreScreen } from "../work";

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
      return {
        asOf: tickets.asOf, sourceWatermark: tickets.sourceWatermark, partialFailures: sla ? [] : ["SLA summary is unavailable"],
        snapshot: { tickets: [...tickets.snapshot.items], sla: sla?.snapshot },
      };
    },
    isEmpty: (data) => data.tickets.length === 0,
    refreshMs: 20_000,
  });
  const incidents = createScopedRead<IncidentSummary[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await incidentsQuery(scope.workspaceId, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 20_000,
  });
  return <main data-testid="tv-kiosk" class="flex flex-col gap-field-gap p-8">
    <header class="flex items-center justify-between">
      <h1 class="text-heading">Keyrus Brain — {props.area === "support" ? "Support" : "SRE"} board</h1>
      <p class="text-caption text-ink-gray-7">Read-only redacted view · auto-refreshing</p>
    </header>
    <Show when={props.area === "support"} fallback={
      <SreScreen incidents={incidents.state().data ?? []} state={incidents.state()}
        onRefresh={() => void incidents.refresh({ force: true })} onOpenIncident={() => undefined}
        onDispatch={() => undefined} canDispatch={false} />
    }>
      <SupportScreen tickets={support.state().data?.tickets ?? []} sla={support.state().data?.sla}
        state={support.state()} onRefresh={() => void support.refresh({ force: true })}
        onOpenTicket={() => undefined} onDispatch={() => undefined} canDispatch={false} />
    </Show>
  </main>;
}
