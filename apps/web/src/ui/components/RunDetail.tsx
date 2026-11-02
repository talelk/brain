import { A } from "@solidjs/router";
import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { Button, KeyValue } from "@talelk/newui-atoms";
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
import { BrainPage, PageStack, TechnicalDetails } from "./PageLayout";
import { ReasonDialog } from "./ReasonDialog";
import { RefreshButton } from "./primitives";
import { DetailAside, FactStrip, WorkspaceSection } from "./Domain";

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
    actions={<><RefreshButton onClick={props.onRefresh} label="Refresh" /><Show when={unknown()}><Button size="lg" variant="solid" theme="blue" iconLeft="lucide-list-checks" onClick={() => { setReasonOpen("reconcile"); setReason(""); }}>Reconcile outcome</Button></Show><Show when={!unknown() && !["succeeded", "failed", "cancelled"].includes(state() ?? "")}><Button size="lg" variant="outline" theme="red" iconLeft="lucide-circle-stop" onClick={() => { setReasonOpen("cancel"); setReason(""); }}>Cancel run</Button></Show></>}>
    <ScreenRegion state={props.state} skeleton="rows" emptyTitle="Run not found" emptyDescription="It may belong to another workspace, or it was removed." emptyAction={<Button size="md" variant="outline" onClick={props.onRefresh}>Reload</Button>} onRetry={props.onRefresh}>
      <PageStack>
        <DetailHeader title={job()?.workflowTitle ?? "Task run"} headingLevel={2}
          subtitle={job()?.origin ? "Execution linked to an originating work item." : "Authoritative execution, output and independent verification."}
          status={{ label: state() === "succeeded" ? job()?.workflowState ? "Completed and verified" : "Step completed" : (state() ?? "unknown").replaceAll("_", " "), theme: statusHeaderTheme("job", state() ?? "") }} />
        <Show when={unknown()}><Alert theme="amber" variant="outline" title="Effect outcome is unknown" description="The effect may already have applied. Reconcile against the target system before considering another attempt; generic Retry is intentionally unavailable." /></Show>
        <Show when={job()?.origin}>{(origin) => <A class="inline-flex w-fit items-center gap-2 rounded-control text-interface font-medium text-ink-blue-link focus-visible:focus-ring" href={origin().kind === "work-item" ? `/w/${job()?.workspaceId}/board?card=${encodeURIComponent(origin().id)}` : origin().kind === "ticket" ? `/tickets/${origin().id}` : `/incidents/${origin().id}`}><span class="lucide-arrow-left size-4" aria-hidden="true" />Back to originating work item</A>}</Show>
        <FactStrip label="Run summary" items={[
          { label: "Current state", value: <StatusBadge kind="job" status={state() ?? "unknown"} />, hint: "Authoritative workflow state", icon: "lucide-activity" },
          { label: "Attempts", value: String(job()?.attempts.length ?? 0), hint: "Recorded execution attempts", icon: "lucide-repeat-2" },
          { label: "Evidence", value: job()?.evidenceDigest ? "Bundle attached" : "Not complete", hint: job()?.evidenceDigest ? "Inspect independent verification" : "Author output alone is insufficient", icon: "lucide-badge-check" },
          { label: "Created", value: <DateText value={job()?.createdAt} />, hint: `Workspace ${job()?.workspaceId ?? "—"}`, icon: "lucide-clock-3" },
        ]} />
        <Show when={job()?.workspaceId}>
          <fieldset class="m-0 flex flex-wrap items-center gap-2 border-0 p-0">
            <legend class="sr-only">Open this run in the execution surfaces</legend>
            <span class="text-caption text-ink-gray-6">Continue in</span>
            <Show when={job()?.sessionId}><CorrelationLink target={{ kind: "session", sessionId: job()!.sessionId! }} label="Live console" icon="lucide-square-terminal" /></Show>
            <CorrelationLink target={{ kind: "logs", workspaceId: job()?.workspaceId ?? "", filters: { job: props.jobId, ...(lastAttempt() ? { attempt: lastAttempt()!.attemptId } : {}), severity: [], emitter: [] } }} label="Logs" icon="lucide-scroll-text" />
            <CorrelationLink target={{ kind: "outputs", workspaceId: job()?.workspaceId ?? "", jobId: props.jobId }} label="Outputs" icon="lucide-package" />
          </fieldset>
        </Show>
        <div class="brain-run-layout">
          <div class="brain-detail-stack">
            <TabButtons label="Run inspector" options={TABS} value={tab()} onValueChange={setTab} />
            <Show when={tab() === "summary"}><PageStack>
              <WorkspaceSection title="What is happening" description="The latest authoritative condition, not a model's claim of completion.">
                <Show when={latestEvent()} keyed fallback={<p class="text-interface text-ink-gray-7">{job()?.queueReasons.length ? queueReasonLabel(job()!.queueReasons) : "No engine event has been recorded yet. Placement and attempt details below explain the current wait."}</p>}>
                  {(event) => <div class="flex items-start gap-3 border-y border-outline-gray-1 py-4"><span class="mt-1 grid size-9 shrink-0 place-items-center rounded-control bg-surface-blue-2 text-ink-blue-8"><span class="lucide-activity size-4" aria-hidden="true" /></span><div><h3 class="text-base-medium capitalize">{eventTitle(event.kind)}</h3><p class="mt-1 text-caption text-ink-gray-6">Latest engine event · <DateText value={event.occurredAt} /></p></div></div>}
                </Show>
                <Show when={job()?.queueReasons.length}><Alert theme="amber" variant="outline" title="Why the run is waiting" description={queueReasonLabel(job()!.queueReasons)} /></Show>
              </WorkspaceSection>
              <Show when={Object.keys(job()?.runOutputs ?? {}).length}>
                <WorkspaceSection title="Structured output" description="Readable author output; independent evidence is checked separately."><div class="flex flex-col gap-5">
                  <For each={Object.entries(job()?.runOutputs ?? {}).filter(([step]) => step !== "validate")}>{([step, output]) => <div><h3 class="mb-2 text-base-medium capitalize">{step === "respond" ? "Result" : step.replaceAll("-", " ")}</h3><StructuredOutputView value={output} /></div>}</For>
                </div></WorkspaceSection>
              </Show>
            </PageStack></Show>
            <Show when={tab() === "attempts"}><WorkspaceSection title="Execution attempts" description="Runner, lease and terminal state for each admitted attempt; each attempt's logs open in the Log Explorer.">
              <Show when={(job()?.attempts.length ?? 0) > 0} fallback={<p class="brain-empty-inline">No attempts recorded yet.</p>}><Timeline items={[...(job()?.attempts ?? [])].map((attempt) => ({
                title: `Attempt ${attempt.number} on ${attempt.runnerId}`,
                description: `State: ${attempt.state}${attempt.leaseExpiresAt ? ` · lease until ${formatDateTime(attempt.leaseExpiresAt)}` : ""}`,
                tone: (attempt.state === "succeeded" ? "green" : attempt.state === "failed" ? "red" : "blue") as "green" | "red" | "blue",
                timestamp: <Show when={job()?.workspaceId} fallback={<DateText value={attempt.leaseExpiresAt} />}>
                  <span class="flex items-center gap-2"><DateText value={attempt.leaseExpiresAt} />
                    <CorrelationLink target={{ kind: "logs", workspaceId: job()?.workspaceId ?? "", filters: { job: props.jobId, attempt: attempt.attemptId, severity: [], emitter: [] } }} label="Logs" icon="lucide-scroll-text" /></span>
                </Show>,
              }))} /></Show>
            </WorkspaceSection></Show>
            <Show when={tab() === "evidence"}><WorkspaceSection title="Independent evidence" description="Verification is accepted only from the independent evaluator authority."><EvidenceList bundleDigest={job()?.evidenceDigest} workspaceId={job()?.workspaceId} /></WorkspaceSection></Show>
            <Show when={tab() === "placement"}><WorkspaceSection title="Placement explanation" description="Why this run can or cannot be assigned to a runner."><PlacementPanel explanation={props.explanation} /></WorkspaceSection></Show>
          </div>
          <DetailAside title="Run context" description="Placement and provenance beside the result." sticky>
            <KeyValue label="State" value={<StatusBadge kind="job" status={state() ?? "unknown"} />} orientation="vertical" />
            <KeyValue label="Workspace" value={<span class="break-all">{job()?.workspaceId ?? "—"}</span>} orientation="vertical" />
            <KeyValue label="Engine" value={<span class="break-all">{engineId()}</span>} orientation="vertical" />
            <KeyValue label="Runner" value={<span class="break-all">{lastAttempt()?.runnerId ?? "Not assigned"}</span>} orientation="vertical" />
            <KeyValue label="Attempt" value={job()?.attempts.length ? `${job()!.attempts.length} recorded` : "None yet"} orientation="vertical" />
            <KeyValue label="Session" value={<Show when={job()?.sessionId} fallback={<span>Not bound</span>}><CorrelationLink target={{ kind: "session", sessionId: job()!.sessionId! }} label={job()!.sessionId!} icon="lucide-square-terminal" /></Show>} orientation="vertical" />
            <KeyValue label="Cost / budget" value="Actual cost is not supplied by this run read model." orientation="vertical" />
            <TechnicalDetails label="Technical references"><p class="break-all">Run {job()?.workflowRunId ?? props.jobId} · step {job()?.jobId} · version {job()?.version} · configuration {job()?.configDigest}</p></TechnicalDetails>
          </DetailAside>
        </div>
      </PageStack>
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
