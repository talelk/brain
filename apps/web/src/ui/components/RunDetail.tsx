import { A } from "@solidjs/router";
import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Button } from "@talelk/newui-atoms";
import { Alert, TabButtons, Timeline } from "@talelk/newui-molecules";
import { DetailHeader } from "@talelk/newui-organisms";
import type { JobSnapshot, PlacementExplanation } from "@brain/contracts";
import { DateText, ScreenRegion } from "../screen-region";
import type { ScreenState } from "../../data/screens";
import { CorrelationLink } from "../exec/CorrelationLink";
import { EvidenceList } from "./EvidenceList";
import { PlacementPanel } from "./PlacementPanel";
import { formatDateTime, queueReasonLabel } from "../format";
import { StatusBadge, statusHeaderTheme } from "./StatusBadge";
import { StructuredOutputView } from "./StructuredOutputView";
import { BrainPage, TechnicalDetails } from "./PageLayout";
import { ReasonDialog } from "./ReasonDialog";
import { DetailAside, WorkspaceSection } from "./Domain";
/**
 * The run inspector (T60): state, attempts, evidence and placement for one
 * run, linked out to the execution surfaces. It deliberately does not
 * reproduce a second session feed, a second logs viewer or a second output
 * browser — those live in the Live console, Log Explorer and Output Browser;
 * this page deep-links to them with the run's filters attached.
 */

/** The server resolves the producing session onto the snapshot (brain.ts); the generated type catches up with the contracts regeneration. */
export type RunJobSnapshot = JobSnapshot & { readonly sessionId?: string };

const TABS = [
  { value: "summary", label: "Summary" }, { value: "attempts", label: "Attempts" },
  { value: "evidence", label: "Evidence" }, { value: "placement", label: "Placement" },
];

function RunFact(props: { label: string; value: JSX.Element }): JSX.Element {
  return <div class="min-w-0"><dt class="text-ink-gray-6">{props.label}</dt><dd class="mt-0.5 min-w-0 break-words text-ink-gray-9">{props.value}</dd></div>;
}

export function RunDetail(props: {
  jobId: string;
  job?: RunJobSnapshot;
  explanation?: PlacementExplanation;
  state: ScreenState<JobSnapshot>;
  onRefresh: () => void;
  onCancel: (reason: string) => Promise<void>;
  onReconcile: (reason: string) => Promise<void>;
}): JSX.Element {
  const [tab, setTab] = createSignal("summary");
  const [reasonOpen, setReasonOpen] = createSignal<false | "cancel" | "reconcile">(false);
  const [reason, setReason] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const job = () => props.job;
  const state = () => job()?.workflowState ?? job()?.state;
  const unknown = () => job()?.state === "outcome_unknown";
  const latestEvent = () => job()?.engineEvents?.at(-1);
  const engineId = () => {
    const current = job()?.engineEvents?.find((event) => event.kind === "session.started");
    return current?.kind === "session.started" ? current.payload.engine.id : "Not reported";
  };
  const lastAttempt = () => job()?.attempts.at(-1);
  const eventTitle = (kind: string) => kind.replaceAll(".", " · ").replaceAll("-", " ");
  async function confirm() {
    const kind = reasonOpen();
    if (!kind || !reason().trim()) return;
    setBusy(true);
    try {
      if (kind === "cancel") await props.onCancel(reason().trim());
      else await props.onReconcile(reason().trim());
      setReason(""); setReasonOpen(false);
    } finally { setBusy(false); }
  }
  return <BrainPage title="Run inspector" description="What the run is doing, what proves it, and where the live console, logs and outputs continue."
    breadcrumbs={[{ label: "Runs" }, { label: "Run inspector" }]}
    actions={<><Button variant="outline" iconLeft="lucide-refresh-cw" onClick={props.onRefresh}>Refresh</Button><Show when={unknown()}><Button variant="solid" theme="blue" iconLeft="lucide-list-checks" onClick={() => { setReasonOpen("reconcile"); setReason(""); }}>Reconcile outcome</Button></Show><Show when={!unknown() && !["succeeded", "failed", "cancelled"].includes(state() ?? "")}><Button variant="outline" theme="red" iconLeft="lucide-circle-stop" onClick={() => { setReasonOpen("cancel"); setReason(""); }}>Cancel run</Button></Show></>}>
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Run not found" emptyDescription="It may belong to another workspace, or it was removed." emptyAction={<Button variant="outline" onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
      <div class="flex min-w-0 flex-col gap-4">
        <DetailHeader title={job()?.workflowTitle ?? "Task run"} headingLevel={2}
          subtitle={job()?.origin ? "Execution linked to an originating work item." : "Authoritative execution, output and independent verification."}
          status={{ label: state() === "succeeded" ? job()?.workflowState ? "Completed and verified" : "Step completed" : (state() ?? "unknown").replaceAll("_", " "), theme: statusHeaderTheme("job", state() ?? "") }} />
        <Show when={unknown()}><Alert theme="amber" variant="outline" title="Effect outcome is unknown" description="The effect may already have applied. Reconcile against the target system before considering another attempt; generic Retry is intentionally unavailable." /></Show>
        <Show when={job()?.origin}>{(origin) => <A class="inline-flex w-fit items-center gap-2 rounded-control text-interface font-medium text-ink-blue-link focus-visible:focus-ring" href={origin().kind === "work-item" ? `/w/${job()?.workspaceId}/board?card=${encodeURIComponent(origin().id)}` : origin().kind === "ticket" ? `/tickets/${origin().id}` : `/incidents/${origin().id}`}><span class="lucide-arrow-left size-4" aria-hidden="true" />Back to originating work item</A>}</Show>
        <dl class="grid grid-cols-2 border-y border-outline-gray-1 text-caption sm:grid-cols-4" aria-label="Run summary">
          <div class="min-w-0 py-2 pr-3" title="Authoritative workflow state"><dt class="text-ink-gray-6">State</dt><dd class="mt-1"><StatusBadge kind="job" status={state() ?? "unknown"} /></dd></div>
          <div class="min-w-0 py-2 pr-3" title="Recorded execution attempts"><dt class="text-ink-gray-6">Attempts</dt><dd class="mt-1 font-medium tabular-nums text-ink-gray-9">{job()?.attempts.length ?? 0}</dd></div>
          <div class="min-w-0 py-2 pr-3" title={job()?.evidenceDigest ? "Inspect independent verification" : "Author output alone is insufficient"}><dt class="text-ink-gray-6">Evidence</dt><dd class="mt-1 font-medium text-ink-gray-9">{job()?.evidenceDigest ? "Bundle attached" : "Not complete"}</dd></div>
          <div class="min-w-0 py-2 pr-3" title={`Workspace ${job()?.workspaceId ?? "—"}`}><dt class="text-ink-gray-6">Created</dt><dd class="mt-1 break-words font-medium text-ink-gray-9"><DateText value={job()?.createdAt} /></dd></div>
        </dl>
        <Show when={job()?.workspaceId}>
          <fieldset class="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0">
            <legend class="sr-only">Open this run in the execution surfaces</legend>
            <span class="mr-1 text-caption text-ink-gray-6">Continue in</span>
            <Show when={job()?.sessionId}><CorrelationLink target={{ kind: "session", sessionId: job()!.sessionId! }} label="Live console" icon="lucide-square-terminal" /></Show>
            <CorrelationLink target={{ kind: "logs", workspaceId: job()?.workspaceId ?? "", filters: { job: props.jobId, ...(lastAttempt() ? { attempt: lastAttempt()!.attemptId } : {}), severity: [], emitter: [] } }} label="Logs" icon="lucide-scroll-text" />
            <CorrelationLink target={{ kind: "outputs", workspaceId: job()?.workspaceId ?? "", jobId: props.jobId }} label="Outputs" icon="lucide-package" />
          </fieldset>
        </Show>
        <div class="brain-run-layout">
          <div class="flex min-w-0 flex-col gap-4">
            <TabButtons label="Run inspector" options={TABS} value={tab()} onValueChange={setTab} />
            <Show when={tab() === "summary"}><div class="flex min-w-0 flex-col gap-4">
              <WorkspaceSection title="What is happening" description="The latest authoritative condition, not a model's claim of completion.">
                <Show when={latestEvent()} keyed fallback={<p class="text-interface text-ink-gray-7">{job()?.queueReasons.length ? queueReasonLabel(job()!.queueReasons) : "No engine event has been recorded yet. Placement and attempt details below explain the current wait."}</p>}>
                  {(event) => <div class="flex items-start gap-2.5 border-y border-outline-gray-1 py-3"><span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-control bg-surface-blue-2 text-ink-blue-8"><span class="lucide-activity size-3.5" aria-hidden="true" /></span><div class="min-w-0"><h3 class="break-words text-base-medium capitalize">{eventTitle(event.kind)}</h3><p class="mt-0.5 text-caption text-ink-gray-6">Latest engine event · <DateText value={event.occurredAt} /></p></div></div>}
                </Show>
                <Show when={job()?.queueReasons.length}><Alert theme="amber" variant="outline" title="Why the run is waiting" description={queueReasonLabel(job()!.queueReasons)} /></Show>
              </WorkspaceSection>
              <Show when={Object.keys(job()?.runOutputs ?? {}).length}>
                <WorkspaceSection title="Structured output" description="Readable author output; independent evidence is checked separately."><div class="flex flex-col gap-4">
                  <For each={Object.entries(job()?.runOutputs ?? {}).filter(([step]) => step !== "validate")}>{([step, output]) => <div class="min-w-0"><h3 class="mb-2 text-base-medium capitalize">{step === "respond" ? "Result" : step.replaceAll("-", " ")}</h3><StructuredOutputView value={output} /></div>}</For>
                </div></WorkspaceSection>
              </Show>
            </div></Show>
            <Show when={tab() === "attempts"}><WorkspaceSection title="Execution attempts" description="Runner, lease and terminal state for each admitted attempt; each attempt's logs open in the Log Explorer.">
              <Show when={(job()?.attempts.length ?? 0) > 0} fallback={<p class="brain-empty-inline">No attempts recorded yet.</p>}><Timeline items={[...(job()?.attempts ?? [])].map((attempt) => ({
                title: `Attempt ${attempt.number} on ${attempt.runnerId}`,
                description: `State: ${attempt.state}${attempt.leaseExpiresAt ? ` · lease until ${formatDateTime(attempt.leaseExpiresAt)}` : ""}`,
                tone: (attempt.state === "succeeded" ? "green" : attempt.state === "failed" ? "red" : "blue") as "green" | "red" | "blue",
                timestamp: <Show when={job()?.workspaceId} fallback={<DateText value={attempt.leaseExpiresAt} />}>
                  <span class="flex flex-wrap items-center gap-2"><DateText value={attempt.leaseExpiresAt} />
                    <CorrelationLink target={{ kind: "logs", workspaceId: job()?.workspaceId ?? "", filters: { job: props.jobId, attempt: attempt.attemptId, severity: [], emitter: [] } }} label="Logs" icon="lucide-scroll-text" /></span>
                </Show>,
              }))} /></Show>
            </WorkspaceSection></Show>
            <Show when={tab() === "evidence"}><WorkspaceSection title="Independent evidence" description="Verification is accepted only from the independent evaluator authority."><EvidenceList bundleDigest={job()?.evidenceDigest} workspaceId={job()?.workspaceId} /></WorkspaceSection></Show>
            <Show when={tab() === "placement"}><WorkspaceSection title="Placement explanation" description="Why this run can or cannot be assigned to a runner."><PlacementPanel explanation={props.explanation} /></WorkspaceSection></Show>
          </div>
          <DetailAside title="Run context" description="Placement and provenance beside the result." sticky>
            <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-caption lg:grid-cols-1">
              <RunFact label="State" value={<StatusBadge kind="job" status={state() ?? "unknown"} />} />
              <RunFact label="Workspace" value={job()?.workspaceId ?? "—"} />
              <RunFact label="Engine" value={engineId()} />
              <RunFact label="Runner" value={lastAttempt()?.runnerId ?? "Not assigned"} />
              <RunFact label="Attempt" value={job()?.attempts.length ? `${job()!.attempts.length} recorded` : "None yet"} />
              <RunFact label="Session" value={<Show when={job()?.sessionId} fallback={<span>Not bound</span>}><CorrelationLink target={{ kind: "session", sessionId: job()!.sessionId! }} label={job()!.sessionId!} icon="lucide-square-terminal" /></Show>} />
              <RunFact label="Cost / budget" value="Not supplied by this read model" />
            </dl>
            <TechnicalDetails label="Technical references"><p class="break-all">Run {job()?.workflowRunId ?? props.jobId} · step {job()?.jobId} · version {job()?.version} · configuration {job()?.configDigest}</p></TechnicalDetails>
          </DetailAside>
        </div>
      </div>
      <ReasonDialog open={reasonOpen() !== false} onClose={() => setReasonOpen(false)}
        title={reasonOpen() === "reconcile" ? "Reconcile unknown outcome" : "Cancel this run"}
        description="A named reason is recorded against the exact run and cannot be empty."
        reason={reason()} onReason={setReason} cancelLabel="Back" busy={busy()}
        confirmLabel={reasonOpen() === "reconcile" ? "Record reconciliation request" : "Cancel run"}
        tone={reasonOpen() === "cancel" ? "red" : "blue"}
        onConfirm={(value) => { setReason(value); void confirm(); }} />
    </ScreenRegion>
  </BrainPage>;
}
