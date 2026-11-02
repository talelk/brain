import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Pagination } from "@talelk/newui-molecules";
import { FilterBar } from "@talelk/newui-organisms";
import type { JobSnapshot } from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { BrainPage, PageStack } from "../ui/components/PageLayout";
import { StatusBadge } from "../ui/components/StatusBadge";
import { queueReasonLabel } from "../ui/format";
import { RefreshButton } from "../ui/components/primitives";
import { EmptyPreview, FactStrip, QueueRow } from "../ui/components/Domain";
import { execLiveUrl } from "../ui/exec/exec-filters";
import { CorrelationLink } from "../ui/exec/CorrelationLink";

/**
 * The Runs index (T60): one bounded server page of historical and active runs.
 * Sessions live in the Live console rail, runners have their own screen — this
 * page is the run index and links each run onward to the inspector, the console
 * and the Log Explorer with its filters attached.
 */

/** The server resolves the bound session onto the snapshot (brain.ts). */
export type RunIndexJob = JobSnapshot & { readonly sessionId?: string };

const ACTIVE = ["queued", "offered", "running", "verifying"];
const INTERVENTION = ["blocked", "outcome_unknown", "failed"];
const PAGE_SIZE = 25;

/** Shared client-side pager state: one clamped page accessor per list. */
function paged(rows: () => RunIndexJob[], page: () => number) {
  const pageCount = () => Math.max(1, Math.ceil(rows().length / PAGE_SIZE));
  const current = () => Math.min(Math.max(1, page()), pageCount());
  return {
    pageCount,
    current,
    visible: () => rows().slice((current() - 1) * PAGE_SIZE, current() * PAGE_SIZE),
  };
}

function Pager(props: { label: string; count: number; page: number; onPageChange: (page: number) => void }): JSX.Element {
  return <Show when={props.count > PAGE_SIZE}>
    <Pagination.Root aria-label={props.label} count={props.count} pageSize={PAGE_SIZE} page={props.page} onPageChange={props.onPageChange} class="flex-wrap items-center gap-3">
      <Pagination.Range class="me-auto" />
      <Pagination.PrevTrigger /><Pagination.Pages /><Pagination.NextTrigger />
    </Pagination.Root>
  </Show>;
}

function runTone(job: JobSnapshot): "blue" | "gray" | "red" {
  if (INTERVENTION.includes(job.state)) return "red";
  if (ACTIVE.includes(job.state)) return "blue";
  return "gray";
}

function nextRunAction(job: JobSnapshot): string {
  if (job.state === "outcome_unknown") return "Reconcile outcome";
  if (job.state === "blocked") return "Inspect blocker";
  if (job.state === "succeeded") return "View verified result";
  if (ACTIVE.includes(job.state)) return "Open live run";
  return "Inspect run";
}

export function RunsScreen(props: {
  workspaceId: string;
  jobs: RunIndexJob[];
  filter: string;
  runState: string;
  view: string;
  totalRuns: number;
  nextCursor: string;
  hasPrevious: boolean;
  liveSummary?: { activeSessions: number; activeRuns: number; needsAttention: boolean };
  onFiltersChange: (search: string, state: string, view: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  state: ScreenState<{ jobs: RunIndexJob[] }>;
  onRefresh: () => void;
  onOpenJob: (jobId: string) => void;
  onDispatch: () => void;
  canDispatch: boolean;
}): JSX.Element {
  const navigate = useNavigate();
  const views = [
    { value: "active", label: "Active" }, { value: "waiting", label: "Waiting" },
    { value: "intervention", label: "Needs intervention" }, { value: "history", label: "History" },
  ];
  const [page, setPage] = createSignal(1);
  const viewOf = () => (views.some((entry) => entry.value === props.view) ? props.view : "active");
  const visibleJobs = () => viewOf() === "active" ? props.jobs.filter((job) => ACTIVE.includes(job.state))
    : viewOf() === "waiting" ? props.jobs.filter((job) => ["queued", "offered", "blocked"].includes(job.state))
      : viewOf() === "intervention" ? props.jobs.filter((job) => INTERVENTION.includes(job.state)) : props.jobs;
  const rows = paged(visibleJobs, page);
  return <BrainPage title="Runs" description="Every historical and active run, with its console, logs and outputs one click away."
    actions={<><RefreshButton onClick={props.onRefresh} label="Refresh" /><Show when={props.canDispatch}><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onDispatch}>Start work</Button></Show></>}>
    <PageStack>
      <FactStrip label="Runs summary" items={[
        { label: "Active on this page", value: String(props.jobs.filter((job) => ACTIVE.includes(job.state)).length), hint: "Queued, offered, running or verifying", icon: "lucide-activity" },
        { label: "Needs intervention", value: String(props.jobs.filter((job) => INTERVENTION.includes(job.state)).length), hint: "Blocked, failed or outcome unknown on this page", icon: "lucide-circle-pause" },
        { label: "Runs in this authorized view", value: String(props.totalRuns), hint: props.liveSummary ? `${props.liveSummary.activeSessions} live sessions in the console` : "One bounded server page at a time", icon: "lucide-list" },
      ]} />
      <FilterBar resultCount={visibleJobs().length}
        query={{ value: props.filter, placeholder: "Search task, workflow, or run…", onInput: (value) => props.onFiltersChange(value, props.runState, props.view) }}
        selects={[{ label: "Exact state", value: props.runState || undefined, options: [
          { value: "queued", label: "Queued" }, { value: "offered", label: "Offered" }, { value: "running", label: "Running" }, { value: "verifying", label: "Verifying" },
          { value: "blocked", label: "Blocked" }, { value: "outcome_unknown", label: "Outcome unknown" }, { value: "partial", label: "Partial" },
          { value: "succeeded", label: "Succeeded" }, { value: "failed", label: "Failed" }, { value: "cancelled", label: "Cancelled" },
        ], onValueChange: (value) => props.onFiltersChange(props.filter, value ?? "", props.view) }]}
        chips={[
          ...(props.runState ? [{ label: `State: ${props.runState.replaceAll("_", " ")}`, onRemove: () => props.onFiltersChange(props.filter, "", props.view) }] : []),
          ...(props.filter ? [{ label: `Search: ${props.filter}`, onRemove: () => props.onFiltersChange("", props.runState, props.view) }] : []),
        ]}
        onClearAll={props.filter || props.runState ? () => props.onFiltersChange("", "", props.view) : undefined} />
      <fieldset class="m-0 flex flex-wrap items-center gap-1 border-0 p-0">
        <legend class="sr-only">Run views</legend>
        <For each={views}>{(view) => (
          <button type="button" aria-pressed={viewOf() === view.value}
            class={`rounded-control border px-2.5 py-1 text-caption focus-visible:focus-ring ${viewOf() === view.value ? "border-outline-blue-3 bg-surface-blue-1 text-ink-blue-8" : "border-outline-gray-2 text-ink-gray-7 hover:bg-surface-gray-1"}`}
            onClick={() => props.onFiltersChange(props.filter, props.runState, view.value)}>{view.label}</button>
        )}</For>
      </fieldset>
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No runs match" emptyDescription="Clear the filters or start a declared task." onRetry={props.onRefresh}>
        <Show when={visibleJobs().length} fallback={
          <EmptyPreview icon="lucide-list" title="No runs in this view"
            description={props.liveSummary && props.liveSummary.activeSessions > 0
              ? `${props.liveSummary.activeSessions} agent session${props.liveSummary.activeSessions === 1 ? " is" : "s are"} live right now — the Live console holds them, not this run index.`
              : "Choose History or clear the exact-state filter to inspect other runs."}
            action={props.liveSummary && props.liveSummary.activeSessions > 0
              ? <Button size="md" variant="outline" onClick={() => void navigate(execLiveUrl(props.workspaceId))}>Open the Live console</Button>
              : <Button size="md" variant="outline" onClick={() => props.onFiltersChange(props.filter, props.runState, "history")}>View history</Button>} />}>
          <div class="brain-queue"><For each={rows.visible()}>{(job) => <div class="grid grid-cols-[minmax(0,1fr)_auto] items-stretch gap-2">
            <QueueRow icon="lucide-activity" tone={runTone(job)}
              title={job.workflowTitle ?? "Workflow run"} description={`${job.jobId} · ${job.workspaceId}`}
              meta={<>
                <span>{job.attempts.length} {job.attempts.length === 1 ? "attempt" : "attempts"}</span>
                <span>Created <DateText value={job.createdAt} /></span>
                <span>{job.queueReasons.length ? queueReasonLabel(job.queueReasons) : nextRunAction(job)}</span>
                <Show when={job.attempts.at(-1)?.runnerId}><span>Runner {job.attempts.at(-1)?.runnerId}</span></Show>
              </>}
              trailing={<StatusBadge kind="job" status={job.workflowState ?? job.state} />}
              label={`Open run inspector: ${job.workflowTitle ?? job.jobId}`}
              onClick={() => props.onOpenJob(job.jobId)} />
            <div class="flex flex-col justify-center gap-1 pe-1">
              <Show when={job.sessionId} keyed>{(sessionId) => <CorrelationLink target={{ kind: "session", sessionId }} label="Console" icon="lucide-square-terminal" />}</Show>
              <CorrelationLink target={{ kind: "logs", workspaceId: props.workspaceId, filters: { job: job.jobId, severity: [], emitter: [] } }} label="Logs" icon="lucide-scroll-text" />
            </div>
          </div>}</For></div>
          <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
            <Button size="md" variant="outline" iconLeft="lucide-chevron-left" disabled={!props.hasPrevious || props.state.status === "loading"} onClick={props.onPrevious}>Previous</Button>
            <Show when={rows.pageCount() > 1}><Pager label="Run pages" count={visibleJobs().length} page={rows.current()} onPageChange={setPage} /></Show>
            <span class="text-caption text-ink-gray-6">Server page · {rows.visible().length} shown</span>
            <Button size="md" variant="outline" iconRight="lucide-chevron-right" disabled={!props.nextCursor || props.state.status === "loading"} onClick={props.onNext}>Next</Button>
          </div>
        </Show>
      </ScreenRegion>
    </PageStack>
  </BrainPage>;
}
