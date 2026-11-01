import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Button, Progress } from "@talelk/newui-atoms";
import { TabButtons } from "@talelk/newui-molecules";
import { FilterBar } from "@talelk/newui-organisms";
import type { JobSnapshot, RunnerSnapshot, BrainSession } from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { BrainPage, PageStack } from "../ui/components/PageLayout";
import { StatusBadge } from "../ui/components/StatusBadge";
import { queueReasonLabel } from "../ui/format";
import { CardTile, IconTile, RefreshButton } from "../ui/components/primitives";
import { EmptyPreview, FactStrip, Freshness, WorkspaceSection } from "../ui/components/Domain";

const ACTIVE = ["queued", "offered", "running", "verifying"];
const WAITING = ["queued", "offered", "blocked"];
const INTERVENTION = ["blocked", "outcome_unknown", "failed"];

function nextRunAction(job: JobSnapshot): string {
  if (job.state === "outcome_unknown") return "Reconcile outcome";
  if (job.state === "blocked") return "Inspect blocker";
  if (job.state === "succeeded") return "View verified result";
  if (ACTIVE.includes(job.state)) return "Open live run";
  return "Inspect run";
}

export function RunsScreen(props: {
  workspaceId: string;
  jobs: JobSnapshot[];
  sessions: BrainSession[];
  runners: RunnerSnapshot[];
  filter: string;
  runState: string;
  totalRuns: number;
  nextCursor: string;
  hasPrevious: boolean;
  onFiltersChange: (search: string, state: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  state: ScreenState<{ jobs: JobSnapshot[]; sessions: BrainSession[]; runners: RunnerSnapshot[] }>;
  onRefresh: () => void;
  onOpenJob: (jobId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenRunner: (runnerId: string) => void;
  onDispatch: () => void;
  canDispatch: boolean;
  initialTab?: "runs" | "sessions" | "runners";
}): JSX.Element {
  const [tab, setTab] = createSignal(props.initialTab ?? "runs");
  const [view, setView] = createSignal("active");
  const chooseView = (value: string) => {
    setView(value);
    props.onFiltersChange(props.filter, "");
  };
  const visibleJobs = () => view() === "active" ? props.jobs.filter((job) => ACTIVE.includes(job.state))
    : view() === "waiting" ? props.jobs.filter((job) => WAITING.includes(job.state))
      : view() === "intervention" ? props.jobs.filter((job) => INTERVENTION.includes(job.state)) : props.jobs;
  return <BrainPage title="Activity" description="Understand what is executing, what is waiting, and where a human must intervene."
    actions={<><RefreshButton onClick={props.onRefresh} label="Refresh" /><Show when={props.canDispatch}><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onDispatch}>Start work</Button></Show></>}>
    <PageStack>
      <FactStrip label="Current execution page summary" items={[
        { label: "Active on this page", value: String(props.jobs.filter((job) => ACTIVE.includes(job.state)).length), hint: "Queued, offered, running or verifying", icon: "lucide-activity" },
        { label: "Needs intervention", value: String(props.jobs.filter((job) => INTERVENTION.includes(job.state)).length), hint: "Blocked, failed or outcome unknown on this page", icon: "lucide-circle-pause" },
        { label: "Runners online", value: String(props.runners.filter((runner) => runner.connectivity === "online").length), hint: `${props.runners.length} enrolled in this authorized view`, icon: "lucide-server" },
      ]} />
      <TabButtons label="Activity sources" options={[
        { value: "runs", label: `Runs (${props.totalRuns})` }, { value: "sessions", label: `Sessions (${props.sessions.length})` }, { value: "runners", label: `Runners (${props.runners.length})` },
      ]} value={tab()} onValueChange={setTab} />
      <Show when={tab() === "runs"}><PageStack>
        <TabButtons label="Execution views" options={[{ value: "active", label: "Active" }, { value: "waiting", label: "Waiting" }, { value: "intervention", label: "Needs intervention" }, { value: "history", label: "History" }]} value={view()} onValueChange={chooseView} />
        <FilterBar resultCount={visibleJobs().length}
          query={{ value: props.filter, placeholder: "Search task, workflow, or run…", onInput: (value) => props.onFiltersChange(value, props.runState) }}
          selects={[{ label: "Exact state", value: props.runState || undefined, options: [
            { value: "queued", label: "Queued" }, { value: "offered", label: "Offered" }, { value: "running", label: "Running" }, { value: "verifying", label: "Verifying" },
            { value: "blocked", label: "Blocked" }, { value: "outcome_unknown", label: "Outcome unknown" }, { value: "partial", label: "Partial" },
            { value: "succeeded", label: "Succeeded" }, { value: "failed", label: "Failed" }, { value: "cancelled", label: "Cancelled" },
          ], onValueChange: (value) => props.onFiltersChange(props.filter, value ?? "") }]}
          chips={[
            ...(props.runState ? [{ label: `State: ${props.runState.replaceAll("_", " ")}`, onRemove: () => props.onFiltersChange(props.filter, "") }] : []),
            ...(props.filter ? [{ label: `Search: ${props.filter}`, onRemove: () => props.onFiltersChange("", props.runState) }] : []),
          ]}
          onClearAll={props.filter || props.runState ? () => props.onFiltersChange("", "") : undefined} />
        <WorkspaceSection title="Execution control" description="One bounded server page. Select a run for its current step, proof, placement and safe next action.">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No runs match" emptyDescription="Clear the filters or start a declared task." onRetry={props.onRefresh}>
            <Show when={visibleJobs().length} fallback={<EmptyPreview icon="lucide-activity" title="No runs in this view" description="Choose History or clear the exact-state filter to inspect other runs." action={<Button size="lg" variant="outline" onClick={() => chooseView("history")}>View history</Button>} />}>
              <div class="brain-queue"><For each={visibleJobs()}>{(job) => <article class="grid gap-3 border-b border-outline-gray-1 px-2 py-4 lg:grid-cols-[minmax(0,1.5fr)_auto_minmax(12rem,0.8fr)_auto] lg:items-center">
                <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h3 class="break-words text-base-medium text-ink-gray-9">{job.workflowTitle ?? "Workflow run"}</h3><StatusBadge kind="job" status={job.workflowState ?? job.state} /></div><p class="mt-1 break-all text-caption text-ink-gray-6">{job.jobId} · {job.workspaceId}</p></div>
                <div class="text-caption text-ink-gray-6"><span class="block text-ink-gray-7">{job.attempts.length} {job.attempts.length === 1 ? "attempt" : "attempts"}</span><span class="mt-1 block">Created <DateText value={job.createdAt} /></span></div>
                <div class="min-w-0 text-interface text-ink-gray-7"><span class="block text-caption text-ink-gray-6">Current / next condition</span><p class="mt-1 break-words">{job.queueReasons.length ? queueReasonLabel(job.queueReasons) : nextRunAction(job)}</p><Show when={job.attempts.at(-1)?.runnerId}><p class="mt-1 break-all text-caption text-ink-gray-6">Runner {job.attempts.at(-1)?.runnerId}</p></Show></div>
                <Button size="lg" variant="outline" iconRight="lucide-arrow-right" aria-label={`Open: ${job.jobId}`} onClick={() => props.onOpenJob(job.jobId)}>{nextRunAction(job)}</Button>
              </article>}</For></div>
              <div class="mt-4 flex flex-wrap items-center justify-between gap-3"><Button size="lg" variant="outline" disabled={!props.hasPrevious || props.state.status === "loading"} onClick={props.onPrevious}>Previous</Button><span class="text-caption text-ink-gray-6">Server page · {visibleJobs().length} shown</span><Button size="lg" variant="outline" disabled={!props.nextCursor || props.state.status === "loading"} onClick={props.onNext}>Next</Button></div>
            </Show>
          </ScreenRegion>
        </WorkspaceSection>
      </PageStack></Show>
      <Show when={tab() === "sessions"}>
        <WorkspaceSection title="Live agent sessions" description="Model turns, tool activity and usage from real engine sessions.">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No sessions yet" emptyDescription="Sessions appear while a claimed run is executing on a runner." onRetry={props.onRefresh}>
            <div class="brain-queue"><For each={props.sessions}>{(session) => <article class="grid gap-3 border-b border-outline-gray-1 px-2 py-4 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
              <div class="min-w-0"><h3 class="break-words text-base-medium text-ink-gray-9">{session.task}</h3><p class="mt-1 break-all text-caption text-ink-gray-6">{session.engine.id} · attempt {session.attemptId}</p></div>
              <div class="flex flex-wrap items-center gap-3"><StatusBadge status={session.state} /><span class="text-caption tabular-nums text-ink-gray-6">{session.usedTokens.toLocaleString()} tokens</span></div>
              <Button size="lg" variant="outline" iconRight="lucide-arrow-right" onClick={() => props.onOpenSession(session.sessionId)}>Open session</Button>
            </article>}</For></div>
          </ScreenRegion>
        </WorkspaceSection>
      </Show>
      <Show when={tab() === "runners"}>
        <WorkspaceSection title="Execution fleet" description="Connectivity, administrative state and resource reservations are independent facts.">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No runners enrolled" emptyDescription="Enroll an outbound runner supervisor to accept work for this organization." onRetry={props.onRefresh}>
            <div class="grid gap-4 md:grid-cols-2"><For each={props.runners}>{(runner) => <CardTile wide class="flex flex-col gap-4">
              <div class="flex items-start justify-between gap-3"><div class="flex min-w-0 items-center gap-3"><IconTile icon="lucide-server" tone={runner.connectivity === "online" ? "blue" : "gray"} /><div class="min-w-0"><h3 class="break-all text-base-medium text-ink-gray-9">{runner.runnerId}</h3><p class="mt-1 text-caption text-ink-gray-6">Group {runner.group} · {runner.health}</p></div></div><StatusBadge kind="runner" status={runner.displayStatus} /></div>
              <div class="flex flex-wrap gap-2"><StatusBadge kind="connection" status={runner.connectivity} /><Show when={runner.adminState !== "enabled"}><StatusBadge kind="runner" status={runner.adminState} /></Show></div>
              <div><div class="mb-2 flex justify-between gap-2 text-caption text-ink-gray-7"><span>Attempt slots reserved</span><span class="tabular-nums">{runner.reserved.slots}/{runner.capacity.slots}</span></div><Progress label="Slots reserved" value={runner.reserved.slots / Math.max(1, runner.capacity.slots) * 100} /></div>
              <p class="text-caption text-ink-gray-7">{runner.reserved.cpuMillicores}m CPU · {runner.reserved.memoryMb} MB memory reserved</p>
              <div class="flex flex-wrap items-center justify-between gap-3"><Freshness value={runner.lastSeenAt} stale={runner.connectivity === "offline"} label="Heartbeat" /><Button size="lg" variant="outline" iconRight="lucide-arrow-right" onClick={() => props.onOpenRunner(runner.runnerId)}>Inspect runner</Button></div>
            </CardTile>}</For></div>
          </ScreenRegion>
        </WorkspaceSection>
      </Show>
    </PageStack>
  </BrainPage>;
}
