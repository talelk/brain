import { Show } from "solid-js";
import { WorkItemTasks } from "../../ui/components/WorkItemTasks";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import type { IncidentDetail } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { incidentQuery } from "../../data/governor";
import { IncidentDetailScreen } from "../workspace";
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
  return <div class="flex flex-col gap-field-gap"><IncidentDetailScreen incident={incident.state().data} state={incident.state()}
    onRefresh={() => void incident.refresh({ force: true })} onBack={() => void navigate(`/w/${workspaceId()}/sre`)} /><Show when={incident.state().data}><WorkItemTasks origin={{ kind: "incident", id: incidentId() }} /></Show></div>;
}
