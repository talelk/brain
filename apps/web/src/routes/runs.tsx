import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import { Pagination, EmptyState } from "@talelk/newui-molecules";
import { FilterBar } from "@talelk/newui-organisms";
import type { JobSnapshot } from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { PageStack } from "../ui/components/PageLayout";
import { StatusBadge } from "../ui/components/StatusBadge";
import { queueReasonLabel, runStatusKey, runTitle } from "../ui/format";
import { QueueRow, WorkspaceSection } from "../ui/components/Domain";import { execLiveUrl } from "../ui/exec/exec-filters";
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

/** The Governor decides, with the same rule as Today's Needs-you queue: only unresolved runs ask for a person. */
const needsYou = (job: JobSnapshot): boolean => job.needsYou === true;

function runTone(job: JobSnapshot): "blue" | "gray" | "red" {
  if (needsYou(job)) return "red";
  if (ACTIVE.includes(job.state)) return "blue";
  return "gray";
}

const SETTLED: Record<string, string> = {
  "retried-and-succeeded": "The task was finished by a later attempt.", retried: "Brain started this task again.",
  "mission-closed": "Its mission is closed.", "set-aside": "The task was set aside.",
};

function nextRunAction(job: JobSnapshot): string {
  if (job.context?.resolution && !ACTIVE.includes(job.state)) return SETTLED[job.context.resolution] ?? "";
  if (job.restarting) return "Brain is restarting it";
  if (job.state === "outcome_unknown") return "Reconcile outcome";
  if (job.state === "blocked") return "Inspect blocker";
  if (job.state === "succeeded") return "View verified result";
  if (job.state === "failed") return "It did not work; open it to see why and what to do next";
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
      : viewOf() === "intervention" ? props.jobs.filter(needsYou) : props.jobs;
  const rows = paged(visibleJobs, page);
  return <WorkspaceSection title="Runs" description="Every historical and active run, with its console, logs and outputs one click away."
    actions={<><Button variant="outline" iconLeft="lucide-refresh-cw" onClick={props.onRefresh}>Refresh</Button><Show when={props.canDispatch}><Button variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onDispatch}>Start work</Button></Show></>}>
    <PageStack>
      <dl class="flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-outline-gray-1 py-2 text-caption" aria-label="Runs summary">
        <div class="flex items-center gap-2" title="Queued, offered, running or verifying on this page"><dt class="text-ink-gray-6">Active</dt><dd class="font-medium tabular-nums text-ink-gray-9">{props.jobs.filter((job) => ACTIVE.includes(job.state)).length}</dd></div>
        <div class="flex items-center gap-2" title="Failed, blocked or outcome-unknown runs that nothing has settled since: the same rule as Needs you on Today"><dt class="text-ink-gray-6">Needs intervention</dt><dd class="font-medium tabular-nums text-ink-gray-9">{props.jobs.filter(needsYou).length}</dd></div>
        <div class="flex items-center gap-2" title={props.liveSummary ? `${props.liveSummary.activeSessions} live sessions in the console` : "One bounded server page at a time"}><dt class="text-ink-gray-6">Authorized runs</dt><dd class="font-medium tabular-nums text-ink-gray-9">{props.totalRuns}</dd></div>
      </dl>
      <FilterBar resultCount={visibleJobs().length}
        query={{ value: props.filter, placeholder: "Search task, mission, workflow, state or run id…", onInput: (value) => props.onFiltersChange(value, props.runState, props.view) }}
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
      <fieldset class="m-0 inline-flex max-w-full flex-wrap self-start overflow-hidden rounded-control border border-outline-gray-2 p-0">
        <legend class="sr-only">Run views</legend>
        <For each={views}>{(view, index) => (
          <button type="button" aria-pressed={viewOf() === view.value}
            class={`px-2.5 py-1 text-caption focus-visible:focus-ring ${index() > 0 ? "border-s border-outline-gray-2" : ""} ${viewOf() === view.value ? "bg-surface-blue-1 text-ink-blue-8" : "text-ink-gray-7 hover:bg-surface-gray-1"}`}
            onClick={() => props.onFiltersChange(props.filter, props.runState, view.value)}>{view.label}</button>
        )}</For>
      </fieldset>
      <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No runs match" emptyDescription="Clear the filters or start a declared task." onRetry={props.onRefresh}>
        <Show when={visibleJobs().length} fallback={
          <EmptyState size="sm" icon="lucide-list" title="No runs in this view"
            description={props.liveSummary && props.liveSummary.activeSessions > 0
              ? `${props.liveSummary.activeSessions} agent session${props.liveSummary.activeSessions === 1 ? " is" : "s are"} live right now — the Live console holds them, not this run index.`
              : "Choose History or clear the exact-state filter to inspect other runs."}
            action={props.liveSummary && props.liveSummary.activeSessions > 0
              ? <Button variant="outline" onClick={() => void navigate(execLiveUrl(props.workspaceId))}>Open the Live console</Button>
              : <Button variant="outline" onClick={() => props.onFiltersChange(props.filter, props.runState, "history")}>View history</Button>} />}>
          <div class="brain-queue [&_.brain-queue-row]:py-2.5"><For each={rows.visible()}>{(job) => <div class="grid grid-cols-1 items-stretch gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-2">
            <QueueRow icon="lucide-activity" tone={runTone(job)}
              title={runTitle(job)} description={job.queueReasons.length ? queueReasonLabel(job.queueReasons) : nextRunAction(job)}
              meta={<>
                <span>{job.attempts.length} {job.attempts.length === 1 ? "attempt" : "attempts"}</span>
                <span>Started <DateText value={job.createdAt} /></span>
                <span class="min-w-0 break-all font-mono text-[11px] text-ink-gray-5" title="Run id">{job.jobId}</span>
                <Show when={job.attempts.at(-1)?.runnerId}><span class="min-w-0 break-all">Runner {job.attempts.at(-1)?.runnerId}</span></Show>
              </>}
              trailing={<StatusBadge kind="job" status={runStatusKey(job)} />}
              label={`Open run inspector: ${runTitle(job)}`}
              onClick={() => props.onOpenJob(job.jobId)} />
            <div class="flex flex-row items-center justify-end gap-1 px-2 pb-2 sm:flex-col sm:justify-center sm:px-0 sm:pb-0 sm:pe-1">
              <Show when={job.sessionId} keyed>{(sessionId) => <CorrelationLink target={{ kind: "session", sessionId }} label="Console" icon="lucide-square-terminal" />}</Show>
              <CorrelationLink target={{ kind: "logs", workspaceId: props.workspaceId, filters: { job: job.jobId, severity: [], emitter: [] } }} label="View logs" icon="lucide-scroll-text" />
              <Button size="xs" variant="ghost" iconLeft="lucide-copy" aria-label={`Copy run id ${job.jobId}`} onClick={() => void navigator.clipboard?.writeText(job.jobId)}>Copy id</Button>
            </div>
          </div>}</For></div>
          <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
            <Button size="sm" variant="outline" iconLeft="lucide-chevron-left" disabled={!props.hasPrevious || props.state.status === "loading"} onClick={props.onPrevious}>Previous</Button>
            <Show when={rows.pageCount() > 1}><Pager label="Run pages" count={visibleJobs().length} page={rows.current()} onPageChange={setPage} /></Show>
            <span class="text-caption text-ink-gray-6">Server page · {rows.visible().length} shown</span>
            <Button size="sm" variant="outline" iconRight="lucide-chevron-right" disabled={!props.nextCursor || props.state.status === "loading"} onClick={props.onNext}>Next</Button>
          </div>
        </Show>
      </ScreenRegion>
    </PageStack>
  </WorkspaceSection>;
}
