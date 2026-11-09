import { BrainPage } from "../../ui/components/PageLayout";
import type { JSX } from "solid-js";
import { Select } from "@talelk/newui-molecules";
import type { BrainSession, Mission, WorkItem } from "@brain/contracts";
import { createScopedRead } from "../../data/screens";
import { query } from "../../data/client";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { useApp } from "../../ui/app-context";
import { readExecFilters, writeExecFilters, type ExecLogFilters } from "../../ui/exec/exec-filters";
import { ConsoleScreen } from "../../ui/console/ConsoleLayout";

/**
 * `/w/:id/live` — the product's primary screen (T60). The three-pane Live
 * console lands here by default while sessions or runs are active; the
 * selected session and the execution filters are carried in this route's URL,
 * so returning from approvals, evidence or a work item restores the console.
 */
export default function LivePage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = () => readExecFilters(searchParams);
  const requestedSession = () => filters().session;
  const patchUrl = (patch: Partial<ExecLogFilters>): void => {
    const next = writeExecFilters({ ...filters(), ...patch });
    setSearchParams({ session: requestedSession(), ...next });
  };
  // All live sessions of the workspace, filterable by mission (#43).
  const missionId = () => (typeof searchParams.mission === "string" ? searchParams.mission : "");
  const scope = createScopedRead<{ missions: Mission[]; items: WorkItem[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      type Envelope<T> = { snapshot: { items: T[] }; asOf: string; sourceWatermark: number };
      const [missions, items] = await Promise.all([
        query<Envelope<Mission>>({ queryType: "missions.list", workspaceId: scope.workspaceId }, signal),
        query<Envelope<WorkItem>>({ queryType: "workItems.list", workspaceId: scope.workspaceId, limit: 100 }, signal),
      ]);
      return { snapshot: { missions: missions.snapshot.items.filter((mission) => mission.state !== "closed"), items: [...items.snapshot.items] }, asOf: missions.asOf, sourceWatermark: missions.sourceWatermark };
    },
    refreshMs: 15_000,
  });
  const include = (session: BrainSession) => !missionId() || (scope.state().data?.items ?? []).some((item) => item.missionId === missionId() && item.workItemId === session.workItemId);
  return <BrainPage title="Live" description="Run, steer and inspect live agent sessions. Active and past sessions share one console.">
  <div class="flex flex-col gap-3">
    <div class="max-w-sm"><Select label="Mission" value={missionId() || "all"} onValueChange={(value) => setSearchParams({ mission: value && value !== "all" ? value : undefined, session: undefined })}
      options={[{ value: "all", label: "All missions" }, ...(scope.state().data?.missions ?? []).map((mission) => ({ value: mission.missionId, label: mission.title }))]} /></div>
    <ConsoleScreen workspaceId={app.workspaceId()} requestedSession={requestedSession()} include={include}
    filters={filters()} onFiltersChange={patchUrl}
    onSessionChange={(sessionId) => void navigate(`/w/${app.workspaceId()}/live?${new URLSearchParams({ ...(missionId() ? { mission: missionId() } : {}), ...(sessionId ? { session: sessionId } : {}) }).toString()}`)} />
  </div>
  </BrainPage>;
}
