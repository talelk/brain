import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Badge, Button, KeyValue } from "@talelk/newui-atoms";
import { TabButtons } from "@talelk/newui-molecules";
import { DataTable, FilterBar, Section, StatGrid } from "@talelk/newui-organisms";
import type { JobSnapshot, RunnerSnapshot, SessionView } from "@brain/contracts";
import { ScreenRegion } from "../ui/screen-region";
import type { ScreenState } from "../data/screens";
import { DateText } from "../ui/screen-region";
import { count } from "../ui/format";

/** Queue reasons are authoritative enums; the column shows what they mean. */
const REASON_LABEL: Record<string, string> = {
  READY: "ready for a runner",
  WAITING_FOR_RUNNER: "waiting for a capable runner",
  BLOCKED_BY_POLICY: "blocked by policy",
  WAITING_FOR_APPROVAL: "waiting for an approval",
  INSUFFICIENT_CAPACITY: "runner capacity exhausted",
  WAITING_FOR_RESOURCE: "waiting for a resource",
  BUDGET_EXHAUSTED: "budget exhausted",
  FAIRNESS_DELAY: "fairness delay",
  RUNNER_OFFLINE: "runner offline",
};
const reasonLabel = (reasons: readonly string[]) => reasons.map((r) => REASON_LABEL[r] ?? r).join(", ") || "none";

/**
 * The Runs area (document 21): one list per authority — runs, sessions,
 * runners — with server-paged reads, an explain control for blocked work and
 * the drain/quarantine controls that keep a runner's old job running.
 */
export function RunsScreen(props: {
  workspaceId: string;
  jobs: JobSnapshot[];
  sessions: SessionView[];
  runners: RunnerSnapshot[];
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
  const [filter, setFilter] = createSignal("");
  const [state, setRunState] = createSignal<string | undefined>();

  const shown = () => props.jobs.filter((job) =>
    (!state() || job.state === state()) &&
    (!filter() || `${job.jobId} ${job.workflowRunId}`.toLowerCase().includes(filter().toLowerCase())),
  );

  return (
    <div class="flex flex-col gap-field-gap">
      <StatGrid columns={4} stats={[
        { label: "Active runs", value: String(props.jobs.filter((j) => ["queued", "offered", "running", "verifying"].includes(j.state)).length) },
        { label: "Blocked", value: String(props.jobs.filter((j) => j.state === "blocked").length) },
        { label: "Unknown outcome", value: String(props.jobs.filter((j) => j.state === "outcome_unknown").length) },
        { label: "Runners online", value: String(props.runners.filter((r) => r.connectivity === "online").length) },
      ]} />
      <TabButtons label="Run views" options={[{ value: "runs", label: `Runs (${props.jobs.length})` }, { value: "sessions", label: `Sessions (${props.sessions.length})` }, { value: "runners", label: `Runners (${props.runners.length})` }]}
        value={tab()} onValueChange={setTab} />

      <Show when={tab() === "runs"}>
        <Section title="Runs" description="Server-paged view of this workspace's runs." surface="card"
          toolbar={<FilterBar surface="bare" resultCount={shown().length}
            query={{ value: filter(), placeholder: "Find by run or job id", onInput: setFilter }}
            selects={[{ label: "State", value: state(), options: [
              { value: "queued", label: "Queued" }, { value: "running", label: "Running" }, { value: "verifying", label: "Verifying" },
              { value: "blocked", label: "Blocked" }, { value: "outcome_unknown", label: "Outcome unknown" },
              { value: "succeeded", label: "Succeeded" }, { value: "failed", label: "Failed" }, { value: "cancelled", label: "Cancelled" },
            ], onValueChange: (value) => setRunState(value) }]}
            onClearAll={() => { setFilter(""); setRunState(undefined); }} />}>
          <Show when={props.canDispatch}>
            <div class="pb-field"><Button onClick={props.onDispatch} class="min-h-11">Dispatch workflow</Button></div>
          </Show>
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No runs yet"
            emptyDescription="Dispatch a declared workflow to see placement and progress here."
            emptyAction={props.canDispatch ? <Button onClick={props.onDispatch}>Dispatch workflow</Button> : undefined}
            onRetry={props.onRefresh}>
            <DataTable rows={shown().map((job) => ({
              id: job.jobId, jobId: job.jobId, state: job.state, run: job.workflowRunId,
              attempts: String(job.attempts.length), created: new Date(job.createdAt).toLocaleString(),
              reasons: reasonLabel(job.queueReasons),
            }))} columns={[
              { id: "jobId", header: "Job", accessorKey: "jobId" },
              { id: "state", header: "State", accessorKey: "state" },
              { id: "run", header: "Run", accessorKey: "run" },
              { id: "attempts", header: "Attempts", accessorKey: "attempts" },
              { id: "reasons", header: "Why waiting", accessorKey: "reasons" },
              { id: "created", header: "Created", accessorKey: "created" },
            ]} title="Runs" hideSearch caption={count(shown().length, "run")}
            onRowsAction={(ids) => props.onOpenJob(ids[0] ?? "")} actionLabel="Open" />
          </ScreenRegion>
        </Section>
      </Show>

      <Show when={tab() === "sessions"}>
        <Section title="Sessions" description="Live engine sessions grouped by attempt." surface="card">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No sessions yet"
            emptyDescription="Sessions appear while a claimed run is executing on a runner."
            onRetry={props.onRefresh}>
            <For each={props.sessions}>{(session) => (
              <article class="flex flex-wrap items-center justify-between gap-control-gap border-b border-outline-gray-1 py-3 last:border-b-0">
                <div class="min-w-0">
                  <h3 class="truncate text-base-medium text-ink-gray-9">{session.task}</h3>
                  <p class="text-caption text-ink-gray-7">job {session.jobId} · attempt {session.attemptId} · engine {session.engine.id} · {session.usedTokens} tokens</p>
                </div>
                <div class="flex items-center gap-control-gap">
                  <Badge theme={session.state === "running" ? "green" : session.state === "failed" ? "red" : "gray"} label={session.state} />
                  <Button onClick={() => props.onOpenSession(session.sessionId)} class="min-h-11">Open live session</Button>
                </div>
              </article>
            )}</For>
          </ScreenRegion>
        </Section>
      </Show>

      <Show when={tab() === "runners"}>
        <Section title="Runners" description="Enrollment, capability and reservation inventory." surface="card">
          <ScreenRegion state={props.state} skeleton="rows" emptyTitle="No runners enrolled"
            emptyDescription="Enroll an outbound runner supervisor to accept work for this organization."
            onRetry={props.onRefresh}>
            <For each={props.runners}>{(runner) => (
              <article class="flex flex-col gap-control-gap border-b border-outline-gray-1 py-3 last:border-b-0">
                <div class="flex flex-wrap items-center justify-between gap-control-gap">
                  <div class="min-w-0">
                    <h3 class="truncate text-base-medium text-ink-gray-9">{runner.runnerId}</h3>
                    <p class="text-caption text-ink-gray-7">group {runner.group} · {runner.connectivity} · last seen <DateText value={runner.lastSeenAt} /></p>
                  </div>
                  <div class="flex items-center gap-control-gap">
                    <Badge theme={runner.displayStatus === "idle" ? "green" : runner.displayStatus === "busy" ? "blue" : runner.displayStatus === "offline" ? "red" : "amber"} label={runner.displayStatus} />
                    <Button variant="outline" onClick={() => props.onOpenRunner(runner.runnerId)} class="min-h-11">Details</Button>
                  </div>
                </div>
                <KeyValue label="Reserved / capacity" value={`${runner.reserved.cpuMillicores}m cpu · ${runner.reserved.memoryMb} MB · ${runner.reserved.slots}/${runner.capacity.slots} slots`} />
              </article>
            )}</For>
          </ScreenRegion>
        </Section>
      </Show>
    </div>
  );
}
