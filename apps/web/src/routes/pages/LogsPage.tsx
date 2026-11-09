import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
import { TabButtons } from "@talelk/newui-molecules";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { BrainPage, PageStack } from "../../ui/components/PageLayout";
import { LogExplorer } from "../../ui/logs/LogExplorer";
import { useApp } from "../../ui/app-context";
import { createScopedRead } from "../../data/screens";
import { jobsQuery } from "../../data/governor";
import { RunsScreen, type RunIndexJob } from "../runs";

/**
 * `/w/:id/logs` — the Log Explorer (T61) and, above it, the run index the
 * removed runs list became (#25): every active and historical run with state
 * filters, each one click from its inspector, console, logs and outputs.
 * The explorer is an independent, searchable view over the Unified Execution
 * Stream: live tail with pause/resume and an unread counter, source and
 * severity filters, full-text search, correlation jumps, tool-call groups,
 * Readable and Raw modes, cross-attempt comparison, bounded sanitized export
 * and error navigation. Run filters use `run*` parameters so both persist in
 * the URL for deep links.
 */
export default function LogsPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = () => (searchParams.view === "runs" ? "runs" : "logs");
  return <BrainPage
    title="Logs"
    description="Search the execution and platform stream, or switch to the run index to open any run.">
    <PageStack>
      <TabButtons label="Logs views" value={tab()} onValueChange={(value) => setSearchParams({ view: value === "runs" ? "runs" : undefined })}
        options={[{ value: "logs", label: "Log explorer" }, { value: "runs", label: "Runs" }]} />
      <Show when={tab() === "runs"} fallback={
        <div class="flex flex-col" style={{ height: "calc(100dvh - 15rem)", "min-height": "36rem" }}>
          <LogExplorer />
        </div>}>
        <RunIndex />
      </Show>
    </PageStack>
  </BrainPage>;
}

function RunIndex(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [previousCursors, setPreviousCursors] = createSignal<string[]>([]);
  const text = (key: string) => (typeof searchParams[key] === "string" ? searchParams[key] as string : "");
  const filter = () => text("runQ");
  const runState = () => text("runState");
  const view = () => text("runView") || "active";
  const cursor = () => text("runCursor");
  const runs = createScopedRead<{ jobs: RunIndexJob[]; nextCursor: string; total: number }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await jobsQuery({ workspaceId: scope.workspaceId, limit: 25, search: filter() || undefined, states: runState() ? [runState()] : undefined, cursor: cursor() || undefined }, signal);
      return { asOf: loaded.asOf, sourceWatermark: loaded.sourceWatermark,
        snapshot: { jobs: [...loaded.snapshot.items], nextCursor: loaded.cursor ?? "", total: loaded.totalEstimate ?? loaded.snapshot.items.length } };
    },
    refreshMs: 10_000,
  });
  // live.status drives the empty state: when sessions are live the index
  // points to the console instead of suggesting there is nothing running.
  const live = app.useLiveStatus();
  const changeFilters = (search: string, state: string, nextView: string) => {
    setPreviousCursors([]); setSearchParams({ runQ: search || undefined, runState: state || undefined, runView: nextView === "active" ? undefined : nextView, runCursor: undefined });
    void runs.refresh({ force: true });
  };
  return <RunsScreen workspaceId={app.workspaceId()}
    jobs={runs.state().data?.jobs ?? []}
    filter={filter()} runState={runState()} view={view()} totalRuns={runs.state().data?.total ?? 0}
    nextCursor={runs.state().data?.nextCursor ?? ""} hasPrevious={previousCursors().length > 0}
    liveSummary={live.state().data ? { activeSessions: live.state().data!.activeSessions, activeRuns: live.state().data!.activeRuns, needsAttention: live.state().data!.needsAttention } : undefined}
    onFiltersChange={changeFilters}
    onNext={() => { const next = runs.state().data?.nextCursor; if (next) { setPreviousCursors((stack) => [...stack, cursor()]); setSearchParams({ runCursor: next }); void runs.refresh({ force: true }); } }}
    onPrevious={() => { const stack = previousCursors(); const previous = stack.at(-1); setPreviousCursors(stack.slice(0, -1)); setSearchParams({ runCursor: previous || undefined }); void runs.refresh({ force: true }); }}
    state={runs.state()} onRefresh={() => void runs.refresh({ force: true })}
    onOpenJob={(jobId) => void navigate(`/runs/${jobId}`)}
    onDispatch={() => void navigate(`/w/${app.workspaceId()}/plays`)}
    canDispatch={app.canDispatch()} />;
}
