import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { createSignal } from "solid-js";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { jobsQuery } from "../../data/governor";
import { RunsScreen, type RunIndexJob } from "../runs";

export default function RunsPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [previousCursors, setPreviousCursors] = createSignal<string[]>([]);
  const filter = () => typeof searchParams.q === "string" ? searchParams.q : "";
  const runState = () => typeof searchParams.state === "string" ? searchParams.state : "";
  const view = () => typeof searchParams.view === "string" ? searchParams.view : "active";
  const cursor = () => typeof searchParams.cursor === "string" ? searchParams.cursor : "";
  const runs = createScopedRead<{ jobs: RunIndexJob[]; nextCursor: string; total: number }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await jobsQuery({ workspaceId: scope.workspaceId, limit: 25, search: filter() || undefined, states: runState() ? [runState()] : undefined, cursor: cursor() || undefined }, signal);
      return { asOf: loaded.asOf, sourceWatermark: loaded.sourceWatermark,
        snapshot: { jobs: [...loaded.snapshot.items], nextCursor: loaded.cursor ?? "", total: loaded.totalEstimate ?? loaded.snapshot.items.length } };
    },
    refreshMs: 10_000,
  });
  // live.status drives the empty-state: when sessions are live the index
  // points to the console instead of suggesting there is nothing running.
  // The read is the app context's shared one — one poll for every consumer.
  const live = app.useLiveStatus();
  const changeFilters = (search: string, state: string, nextView: string) => {
    setPreviousCursors([]); setSearchParams({ q: search || undefined, state: state || undefined, view: nextView === "active" ? undefined : nextView, cursor: undefined });
    void runs.refresh({ force: true });
  };
  return <RunsScreen workspaceId={app.workspaceId()}
    jobs={runs.state().data?.jobs ?? []}
    filter={filter()} runState={runState()} view={view()} totalRuns={runs.state().data?.total ?? 0}
    nextCursor={runs.state().data?.nextCursor ?? ""} hasPrevious={previousCursors().length > 0}
    liveSummary={live.state().data ? { activeSessions: live.state().data!.activeSessions, activeRuns: live.state().data!.activeRuns, needsAttention: live.state().data!.needsAttention } : undefined}
    onFiltersChange={changeFilters}
    onNext={() => { const next = runs.state().data?.nextCursor; if (next) { setPreviousCursors((stack) => [...stack, cursor()]); setSearchParams({ cursor: next }); void runs.refresh({ force: true }); } }}
    onPrevious={() => { const stack = previousCursors(); const previous = stack.at(-1); setPreviousCursors(stack.slice(0, -1)); setSearchParams({ cursor: previous || undefined }); void runs.refresh({ force: true }); }}
    state={runs.state()} onRefresh={() => void runs.refresh({ force: true })}
    onOpenJob={(jobId) => void navigate(`/jobs/${jobId}`)}
    onDispatch={() => void navigate(`/w/${app.workspaceId()}/workflows`)}
    canDispatch={app.canDispatch()} />;
}
