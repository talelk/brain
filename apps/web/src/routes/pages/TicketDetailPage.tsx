import { Show } from "solid-js";
import { WorkItemTasks } from "../../ui/components/WorkItemTasks";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import type { TicketDetail } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { ticketQuery } from "../../data/governor";
import { TicketDetailScreen } from "../workspace";
import { useDetailWorkspace } from './helpers';

export default function TicketDetailPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const workspaceId = useDetailWorkspace();
  const ticketId = () => params.id ?? "";
  const ticket = createScopedRead<TicketDetail>({
    scope: app.scope,
    load: (_scope, signal) => ticketQuery(workspaceId(), ticketId(), signal),
  });
  return <div class="flex flex-col gap-field-gap"><TicketDetailScreen ticket={ticket.state().data} state={ticket.state()}
    onRefresh={() => void ticket.refresh({ force: true })} onBack={() => void navigate(`/w/${workspaceId()}/support`)}
    onOpenApproval={(approvalId) => void navigate(`/approvals/${approvalId}`)} /><Show when={ticket.state().data}><WorkItemTasks origin={{ kind: "ticket", id: ticketId() }} /></Show></div>;
}
