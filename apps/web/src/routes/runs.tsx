import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Button, Progress } from "@talelk/newui-atoms";
import { TabButtons } from "@talelk/newui-molecules";
import { FilterBar, Section, StatGrid } from "@talelk/newui-organisms";
import type { JobSnapshot, RunnerSnapshot, BrainSession } from "@brain/contracts";
import { ScreenRegion, DateText } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { BrainPage, PageStack } from "../ui/components/PageLayout";
import { RecordCollection } from "../ui/components/RecordCollection";
import { StatusBadge } from "../ui/components/StatusBadge";
import { formatDateTime, queueReasonLabel } from "../ui/format";
import { CardTile, RefreshButton } from "../ui/components/primitives";


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
  return <BrainPage title="Activity" description="Follow execution, live model sessions, and runner capacity from their authoritative sources."
    actions={<><RefreshButton onClick={props.onRefresh} label="Refresh" /><Show when={props.canDispatch}><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-play" onClick={props.onDispatch}>Dispatch workflow</Button></Show></>}>
    <PageStack>
      <StatGrid compact columns={4} stats={[
        { label: "Active runs", value: String(props.jobs.filter((job) => ["queued", "offered", "running", "verifying"].includes(job.state)).length), hint: "In execution on this view", icon: "lucide-activity" },
        { label: "Blocked", value: String(props.jobs.filter((job) => job.state === "blocked").length), hint: "Needs attention", icon: "lucide-circle-pause" },
        { label: "Unknown outcomes", value: String(props.jobs.filter((job) => job.state === "outcome_unknown").length), hint: "Reconcile before retrying", icon: "lucide-circle-help" },
        { label: "Runners online", value: String(props.runners.filter((runner) => runner.connectivity === "online").length), hint: `${props.runners.length} enrolled in this view`, icon: "lucide-server" },
      ]} />
      <TabButtons label="Run views" options={[
        { value: "runs", label: `Runs (${props.totalRuns})` }, { value: "sessions", label: `Sessions (${props.sessions.length})` }, { value: "runners", label: `Runners (${props.runners.length})` },
      ]} value={tab()} onValueChange={setTab} />
      <Show when={tab() === "runs"}><PageStack>
        <FilterBar resultCount={props.jobs.length}
          query={{ value: props.filter, placeholder: "Find by run or job id…", onInput: (value) => props.onFiltersChange(value, props.runState) }}
          selects={[{ label: "State", value: props.runState || undefined, options: [
            { value: "queued", label: "Queued" }, { value: "running", label: "Running" }, { value: "verifying", label: "Verifying" },
            { value: "blocked", label: "Blocked" }, { value: "outcome_unknown", label: "Outcome unknown" },
            { value: "succeeded", label: "Succeeded" }, { value: "failed", label: "Failed" }, { value: "cancelled", label: "Cancelled" },
          ], onValueChange: (value) => props.onFiltersChange(props.filter, value ?? "") }]}
          chips={[
            ...(props.runState ? [{ label: `State: ${props.runState.replaceAll("_", " ")}`, onRemove: () => props.onFiltersChange(props.filter, "") }] : []),
            ...(props.filter ? [{ label: `Search: ${props.filter}`, onRemove: () => props.onFiltersChange("", props.runState) }] : []),
          ]}
          onClearAll={props.filter || props.runState ? () => props.onFiltersChange("", "") : undefined} />
        <Section title="Run history" description="Server-filtered pages with attempts, evidence, and placement one click away." surface="card">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No runs match" emptyDescription="Clear the filters or dispatch a declared Workflow." onRetry={props.onRefresh}>
            <RecordCollection title="Runs" rows={props.jobs.map((job) => ({ id: job.jobId, jobId: job.jobId, title: job.workflowTitle ?? job.jobId, state: job.state, run: job.workflowRunId,
              attempts: String(job.attempts.length), created: formatDateTime(job.createdAt), reasons: queueReasonLabel(job.queueReasons) }))} columns={[
              { id: "jobId", header: "Run", accessorKey: "jobId", meta: { mobile: "title" }, cell: (context) => <div class="min-w-0 max-w-[30ch]"><p class="truncate text-base-medium text-ink-gray-9">{context.row.original.title}</p><p class="truncate text-caption text-ink-gray-6">{context.row.original.jobId}</p></div> },
              { id: "state", header: "State", accessorKey: "state", meta: { mobile: "status" }, cell: (context) => <StatusBadge status={context.row.original.state} /> },
              { id: "run", header: "Run", accessorKey: "run", meta: { mobile: "subtitle" }, cell: (context) => <span class="whitespace-nowrap text-caption text-ink-gray-6">{context.row.original.run}</span> },
              { id: "attempts", header: "Attempts", accessorKey: "attempts", meta: { mobile: "meta" } },
              { id: "reasons", header: "Why waiting", accessorKey: "reasons", meta: { mobile: "meta" }, cell: (context) => <span class="whitespace-nowrap text-caption text-ink-gray-6">{context.row.original.reasons}</span> },
              { id: "created", header: "Created", accessorKey: "created", meta: { mobile: "meta" }, cell: (context) => <span class="whitespace-nowrap text-caption text-ink-gray-6">{context.row.original.created}</span> },
            ]} recordsLabel="runs on this page" onOpen={props.onOpenJob} hasNext={Boolean(props.nextCursor)} hasPrevious={props.hasPrevious}
              onNext={props.onNext} onPrevious={props.onPrevious} loading={props.state.status === "loading"} />
          </ScreenRegion>
        </Section>
      </PageStack></Show>
      <Show when={tab() === "sessions"}>
        <Section title="Live sessions" description="Engine sessions grouped by attempt, with token usage and current state." surface="card">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No sessions yet" emptyDescription="Sessions appear while a claimed run is executing on a runner." onRetry={props.onRefresh}>
            <RecordCollection title="Sessions" rows={props.sessions.map((session) => ({ id: session.sessionId, task: session.task, state: session.state,
              detail: `${session.engine.id} · attempt ${session.attemptId}`, tokens: session.usedTokens.toLocaleString() }))} columns={[
              { id: "task", header: "Task", accessorKey: "task", meta: { mobile: "title" } },
              { id: "state", header: "State", accessorKey: "state", meta: { mobile: "status" }, cell: (context) => <StatusBadge status={context.row.original.state} /> },
              { id: "detail", header: "Engine / attempt", accessorKey: "detail", meta: { mobile: "subtitle" } },
              { id: "tokens", header: "Tokens", accessorKey: "tokens", meta: { mobile: "meta" } },
            ]} onOpen={props.onOpenSession} openLabel="Open session" recordsLabel="sessions" />
          </ScreenRegion>
        </Section>
      </Show>
      <Show when={tab() === "runners"}>
        <Section title="Runner inventory" description="Enrollment, verified capabilities, connectivity, and resource reservations." surface="card">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No runners enrolled" emptyDescription="Enroll an outbound runner supervisor to accept work for this organization." onRetry={props.onRefresh}>
            <div class="brain-field-grid">
              <For each={props.runners}>{(runner) => <CardTile class="flex flex-col gap-4">
                <div class="flex items-start justify-between gap-3"><div class="min-w-0"><h3 class="break-all text-base-medium text-ink-gray-9">{runner.runnerId}</h3><p class="mt-1 text-caption text-ink-gray-6">Group {runner.group} · {runner.connectivity} · last seen <DateText value={runner.lastSeenAt} /></p></div><StatusBadge status={runner.displayStatus} /></div>
                <div><div class="mb-2 flex justify-between gap-2 text-caption text-ink-gray-7"><span>Slots reserved</span><span class="tabular-nums">{runner.reserved.slots}/{runner.capacity.slots}</span></div><Progress label="Slots reserved" value={runner.reserved.slots / Math.max(1, runner.capacity.slots) * 100} /></div>
                <p class="text-caption text-ink-gray-7">{runner.reserved.cpuMillicores}m CPU · {runner.reserved.memoryMb} MB memory reserved</p>
                <Button size="lg" variant="outline" iconRight="lucide-arrow-right" class="self-start" onClick={() => props.onOpenRunner(runner.runnerId)}>Inspect runner</Button>
              </CardTile>}</For>
            </div>
          </ScreenRegion>
        </Section>
      </Show>
    </PageStack>
  </BrainPage>;
}
