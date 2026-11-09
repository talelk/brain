import { Show } from "solid-js";
import { WorkItemTasks } from "../../ui/components/WorkItemTasks";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import type { TicketDetail } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { ticketQuery } from "../../data/governor";
import { TicketDetailScreen } from "../workspace";
import { Button } from "@talelk/newui-atoms";
import { PlainSummary } from "../../ui/viz/PlainSummary";
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
  const sentence = () => {
    const t = ticket.state().data; if (!t) return "";
    if (t.state === "resolved" || t.state === "closed") return "This request is closed; nothing is waiting on you.";
    if (t.approvalId) return "A reply is drafted and waiting for approval before anything reaches the customer.";
    if (t.draft) return "A reply is drafted. Review it below; nothing is sent until you approve it.";
    return t.evidenceReady ? "Evidence is ready. Brain can draft a reply for you to review." : "Brain is still gathering evidence. You can start a draft now or wait.";
  };
  const lead = <Show when={ticket.state().data}><div class="flex flex-wrap items-center justify-between gap-3 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-3">
    <PlainSummary icon="lucide-headset">{sentence()}</PlainSummary>
    <Show when={app.canDispatch() && !ticket.state().data?.approvalId && ticket.state().data?.state !== "closed" && ticket.state().data?.state !== "resolved"}><Button variant="solid" theme="blue" iconLeft="lucide-pen-line" onClick={() => void navigate(`/w/${workspaceId()}/plays?originKind=ticket&originId=${encodeURIComponent(ticketId())}`)}>Draft a reply</Button></Show>
  </div></Show>;
  return <div class="flex flex-col gap-4">{lead}<TicketDetailScreen ticket={ticket.state().data} state={ticket.state()}
    onRefresh={() => void ticket.refresh({ force: true })} onBack={() => void navigate(`/w/${workspaceId()}/plays/support`)}
    onOpenApproval={(approvalId) => void navigate(`/approvals/${approvalId}`)} /><Show when={ticket.state().data}><WorkItemTasks origin={{ kind: "ticket", id: ticketId() }} /></Show></div>;
}
