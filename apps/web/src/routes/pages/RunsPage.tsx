import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { createSignal } from "solid-js";
import type { JobSnapshot, RunnerSnapshot, BrainSession } from "@brain/contracts";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { jobsQuery, runnersQuery, sessionsQuery } from "../../data/governor";
import { RunsScreen } from "../runs";

export default function RunsPage(props: { initialTab?: "runs" | "sessions" | "runners" }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [previousCursors, setPreviousCursors] = createSignal<string[]>([]);
  const filter = () => typeof searchParams.q === "string" ? searchParams.q : "";
  const runState = () => typeof searchParams.state === "string" ? searchParams.state : "";
  const cursor = () => typeof searchParams.cursor === "string" ? searchParams.cursor : "";
  const runs = createScopedRead<{ jobs: JobSnapshot[]; sessions: BrainSession[]; runners: RunnerSnapshot[]; nextCursor: string; total: number }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const [j, s, r] = await Promise.all([
        jobsQuery({ workspaceId: scope.workspaceId, limit: 25, search: filter() || undefined, states: runState() ? [runState()] : undefined, cursor: cursor() || undefined }, signal),
        sessionsQuery({ workspaceId: scope.workspaceId }, signal), runnersQuery({ workspaceId: scope.workspaceId }, signal),
      ]);
      return { asOf: j.asOf, sourceWatermark: j.sourceWatermark,
        snapshot: { jobs: [...j.snapshot.items], sessions: [...s.snapshot.items], runners: [...r.snapshot.items], nextCursor: j.cursor ?? "", total: j.totalEstimate ?? j.snapshot.items.length } };
    },
    isEmpty: (data) => data.jobs.length === 0 && data.sessions.length === 0 && data.runners.length === 0, refreshMs: 10_000,
  });
  const changeFilters = (search: string, state: string) => {
    setPreviousCursors([]); setSearchParams({ q: search || undefined, state: state || undefined, cursor: undefined });
    void runs.refresh({ force: true });
  };
  return <RunsScreen workspaceId={app.workspaceId()} initialTab={props.initialTab}
    jobs={runs.state().data?.jobs ?? []} sessions={runs.state().data?.sessions ?? []} runners={runs.state().data?.runners ?? []}
    filter={filter()} runState={runState()} totalRuns={runs.state().data?.total ?? 0} nextCursor={runs.state().data?.nextCursor ?? ""} hasPrevious={previousCursors().length > 0}
    onFiltersChange={changeFilters}
    onNext={() => { const next = runs.state().data?.nextCursor; if (next) { setPreviousCursors((stack) => [...stack, cursor()]); setSearchParams({ cursor: next }); void runs.refresh({ force: true }); } }}
    onPrevious={() => { const stack = previousCursors(); const previous = stack.at(-1); setPreviousCursors(stack.slice(0, -1)); setSearchParams({ cursor: previous || undefined }); void runs.refresh({ force: true }); }}
    state={runs.state()} onRefresh={() => void runs.refresh({ force: true })}
    onOpenJob={(jobId) => void navigate(`/jobs/${jobId}`)} onOpenSession={(sessionId) => void navigate(`/sessions/${sessionId}`)}
    onOpenRunner={(runnerId) => void navigate(`/runners/${runnerId}`)} onDispatch={() => void navigate(`/w/${app.workspaceId()}/workflows`)}
    canDispatch={app.canDispatch()} />;
}
