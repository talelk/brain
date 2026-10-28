import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { WorkspaceSummary } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { bridgeQuery } from "../../data/governor";
import { BridgeScreen } from "../today";

export default function BridgePage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const bridge = createScopedRead<WorkspaceSummary[]>({
    scope: app.scope,
    load: async (_scope, signal) => {
      const loaded = await bridgeQuery({}, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (workspaces) => workspaces.length === 0,
    refreshMs: 30_000,
  });
  return <BridgeScreen workspaces={bridge.state().data ?? []} state={bridge.state()}
    onRefresh={() => void bridge.refresh({ force: true })}
    onOpen={(workspaceId) => { app.selectWorkspace(workspaceId); void navigate(`/w/${workspaceId}/overview`); }} />;
}
