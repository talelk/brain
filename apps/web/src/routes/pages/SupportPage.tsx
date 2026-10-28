import { GovernorError } from "../../data/client";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { SLASummary, TicketSummary } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { slaQuery, ticketsQuery } from "../../data/governor";
import { SupportScreen } from "../work";
import { monthPeriod } from './helpers';

export default function SupportPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
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
    refreshMs: 30_000,
  });
  return <SupportScreen tickets={support.state().data?.tickets ?? []} sla={support.state().data?.sla}
    state={support.state()} onRefresh={() => void support.refresh({ force: true })}
    onOpenTicket={(ticketId) => void navigate(`/tickets/${ticketId}`)}
    onDispatch={() => void navigate(`/w/${app.workspaceId()}/overview`)}
    canDispatch={app.canDispatch()} />;
}
