import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { IncidentSummary } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { incidentsQuery } from "../../data/governor";
import { SreScreen } from "../work";

export default function SrePage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const incidents = createScopedRead<IncidentSummary[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await incidentsQuery(scope.workspaceId, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 15_000,
  });
  return <SreScreen incidents={incidents.state().data ?? []} state={incidents.state()}
    onRefresh={() => void incidents.refresh({ force: true })}
    onOpenIncident={(incidentId) => void navigate(`/incidents/${incidentId}`)}
    onDispatch={() => void navigate(`/w/${app.workspaceId()}/overview`)}
    canDispatch={app.canDispatch()} />;
}
