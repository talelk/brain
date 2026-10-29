import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Button, KeyValue } from "@talelk/newui-atoms";
import { TabButtons } from "@talelk/newui-molecules";
import { FilterBar, Section, StatGrid } from "@talelk/newui-organisms";
import type { JobSnapshot, RunnerSnapshot, SessionView } from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { PageIntro } from "../ui/components/PageLayout";
import { RecordCollection } from "../ui/components/RecordCollection";
import { StatusBadge } from "../ui/components/StatusBadge";

const REASON_LABEL: Record<string, string> = {
  READY: "ready for a runner", WAITING_FOR_RUNNER: "waiting for a capable runner", BLOCKED_BY_POLICY: "blocked by policy",
  WAITING_FOR_APPROVAL: "waiting for an approval", INSUFFICIENT_CAPACITY: "runner capacity exhausted",
  WAITING_FOR_RESOURCE: "waiting for a resource", BUDGET_EXHAUSTED: "budget exhausted", FAIRNESS_DELAY: "fairness delay", RUNNER_OFFLINE: "runner offline",
};
const reasonLabel = (reasons: readonly string[]) => reasons.map((reason) => REASON_LABEL[reason] ?? reason).join(", ") || "none";

export function RunsScreen(props: {
  workspaceId: string;
  jobs: JobSnapshot[];
  sessions: SessionView[];
  runners: RunnerSnapshot[];
  filter: string;
  runState: string;
  totalRuns: number;
  nextCursor: string;
  hasPrevious: boolean;
  onFiltersChange: (search: string, state: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  state: ScreenState<{ jobs: JobSnapshot[]; sessions: SessionView[]; runners: RunnerSnapshot[] }>;
  onRefresh: () => void;
  onOpenJob: (jobId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenRunner: (runnerId: string) => void;
  onDispatch: () => void;
  canDispatch: boolean;
  initialTab?: "runs" | "sessions" | "runners";
}): JSX.Element {
  const [tab, setTab] = createSignal(props.initialTab ?? "runs");
  return <div class="brain-detail-stack">
    <PageIntro title="Execution history" description="Execution state, live model sessions and runner capacity from their authoritative sources."
      actions={<Show when={props.canDispatch}><Button class="min-h-11" onClick={props.onDispatch}>Dispatch Workflow</Button></Show>} />
    <StatGrid columns={4} stats={[
      { label: "Active on this page", value: String(props.jobs.filter((job) => ["queued", "offered", "running", "verifying"].includes(job.state)).length) },
      { label: "Blocked on this page", value: String(props.jobs.filter((job) => job.state === "blocked").length) },
      { label: "Unknown outcome", value: String(props.jobs.filter((job) => job.state === "outcome_unknown").length) },
      { label: "Runners online", value: String(props.runners.filter((runner) => runner.connectivity === "online").length) },
    ]} />
    <TabButtons label="Run views" options={[{ value: "runs", label: `Runs (${props.totalRuns})` }, { value: "sessions", label: `Sessions (${props.sessions.length})` }, { value: "runners", label: `Runners (${props.runners.length})` }]} value={tab()} onValueChange={setTab} />
    <Show when={tab() === "runs"}>
      <Section title="Run history" description="Server-filtered pages; open a run for its attempts, evidence and placement." surface="card"
        toolbar={<FilterBar surface="bare" resultCount={props.jobs.length}
          query={{ value: props.filter, placeholder: "Find by run or job id", onInput: (value) => props.onFiltersChange(value, props.runState) }}
          selects={[{ label: "State", value: props.runState || undefined, options: [
            { value: "queued", label: "Queued" }, { value: "running", label: "Running" }, { value: "verifying", label: "Verifying" },
            { value: "blocked", label: "Blocked" }, { value: "outcome_unknown", label: "Outcome unknown" },
            { value: "succeeded", label: "Succeeded" }, { value: "failed", label: "Failed" }, { value: "cancelled", label: "Cancelled" },
          ], onValueChange: (value) => props.onFiltersChange(props.filter, value ?? "") }]}
          onClearAll={() => props.onFiltersChange("", "")} />}>
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No runs match" emptyDescription="Clear the filters or dispatch a declared Workflow." onRetry={props.onRefresh}>
          <RecordCollection title="Runs" rows={props.jobs.map((job) => ({ id: job.jobId, jobId: job.jobId, state: job.state, run: job.workflowRunId,
            attempts: String(job.attempts.length), created: new Date(job.createdAt).toLocaleString(), reasons: reasonLabel(job.queueReasons) }))} columns={[
            { id: "jobId", header: "Job", accessorKey: "jobId" }, { id: "state", header: "State", accessorKey: "state" },
            { id: "run", header: "Run", accessorKey: "run" }, { id: "attempts", header: "Attempts", accessorKey: "attempts" },
            { id: "reasons", header: "Why waiting", accessorKey: "reasons" }, { id: "created", header: "Created", accessorKey: "created" },
          ]} recordsLabel="runs on this page" onOpen={props.onOpenJob} hasNext={Boolean(props.nextCursor)} hasPrevious={props.hasPrevious}
            onNext={props.onNext} onPrevious={props.onPrevious} loading={props.state.status === "loading"} />
        </ScreenRegion>
      </Section>
    </Show>
    <Show when={tab() === "sessions"}>
      <Section title="Sessions" description="Live engine sessions grouped by attempt." surface="card">
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No sessions yet" emptyDescription="Sessions appear while a claimed run is executing on a runner." onRetry={props.onRefresh}>
          <For each={props.sessions}>{(session) => <article class="flex flex-wrap items-center justify-between gap-control-gap border-b border-outline-gray-1 py-3 last:border-b-0">
            <div class="min-w-0 max-w-2xl"><h3 class="text-base-medium text-ink-gray-9">{session.task}</h3><p class="text-caption text-ink-gray-7">job {session.jobId} · attempt {session.attemptId} · engine {session.engine.id} · {session.usedTokens} tokens</p></div>
            <div class="flex items-center gap-control-gap"><StatusBadge status={session.state} /><Button onClick={() => props.onOpenSession(session.sessionId)} class="min-h-11">Open session</Button></div>
          </article>}</For>
        </ScreenRegion>
      </Section>
    </Show>
    <Show when={tab() === "runners"}>
      <Section title="Runners" description="Enrollment, capability and reservation inventory." surface="card">
        <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No runners enrolled" emptyDescription="Enroll an outbound runner supervisor to accept work for this organization." onRetry={props.onRefresh}>
          <For each={props.runners}>{(runner) => <article class="flex flex-col gap-control-gap border-b border-outline-gray-1 py-3 last:border-b-0">
            <div class="flex flex-wrap items-center justify-between gap-control-gap"><div class="min-w-0"><h3 class="text-base-medium text-ink-gray-9">{runner.runnerId}</h3><p class="text-caption text-ink-gray-7">group {runner.group} · {runner.connectivity} · last seen <DateText value={runner.lastSeenAt} /></p></div>
              <div class="flex items-center gap-control-gap"><StatusBadge status={runner.displayStatus} /><Button variant="outline" onClick={() => props.onOpenRunner(runner.runnerId)} class="min-h-11">Details</Button></div></div>
            <KeyValue label="Reserved / capacity" value={`${runner.reserved.cpuMillicores}m cpu · ${runner.reserved.memoryMb} MB · ${runner.reserved.slots}/${runner.capacity.slots} slots`} />
          </article>}</For>
        </ScreenRegion>
      </Section>
    </Show>
  </div>;
}
