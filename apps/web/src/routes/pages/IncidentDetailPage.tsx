import { Show } from "solid-js";
import { WorkItemTasks } from "../../ui/components/WorkItemTasks";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import type { IncidentDetail } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { incidentQuery } from "../../data/governor";
import { IncidentDetailScreen } from "../workspace";
import { Button } from "@talelk/newui-atoms";
import { PlainSummary } from "../../ui/viz/PlainSummary";
import { useDetailWorkspace } from './helpers';

export default function IncidentDetailPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const workspaceId = useDetailWorkspace();
  const incidentId = () => params.id ?? "";
  const incident = createScopedRead<IncidentDetail>({
    scope: app.scope,
    load: (_scope, signal) => incidentQuery(workspaceId(), incidentId(), signal),
    refreshMs: 30_000,
  });
  const sentence = () => {
    const i = incident.state().data; if (!i) return "";
    if (i.state === "resolved") return "This incident is resolved; nothing is waiting on you.";
    if (i.state === "mitigated") return "The impact is mitigated. Confirm the target is healthy before closing.";
    if (i.state === "investigating") return "An investigation is under way. Follow its tasks below.";
    return `${i.severity === "critical" ? "A critical issue" : "An issue"} on ${i.targetKey} is open and no investigation has started.`;
  };
  const lead = <Show when={incident.state().data}><div class="flex flex-wrap items-center justify-between gap-3 rounded-card border border-outline-gray-1 bg-surface-elevation-1 p-3">
    <PlainSummary icon="lucide-siren">{sentence()}</PlainSummary>
    <Show when={app.canDispatch() && (incident.state().data?.state === "open" || incident.state().data?.state === "investigating")}><Button variant="solid" theme="blue" iconLeft="lucide-scan-search" onClick={() => void navigate(`/w/${workspaceId()}/plays?originKind=incident&originId=${encodeURIComponent(incidentId())}`)}>Start investigation</Button></Show>
  </div></Show>;
  return <div class="flex flex-col gap-4">{lead}<IncidentDetailScreen incident={incident.state().data} state={incident.state()}
    onRefresh={() => void incident.refresh({ force: true })} onBack={() => void navigate(`/w/${workspaceId()}/plays/sre`)} /><Show when={incident.state().data}><WorkItemTasks origin={{ kind: "incident", id: incidentId() }} /></Show></div>;
}
