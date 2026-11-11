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
import { WorkItemLink } from "../exec/WorkItemLink";
import { EvidenceList } from "./EvidenceList";
import { PlacementPanel } from "./PlacementPanel";
import { formatDateTime, queueReasonLabel } from "../format";
import { StatusBadge, statusHeaderTheme } from "./StatusBadge";
import { StatusIcon } from "../viz/StatusIcon";
import { PlainSummary } from "../viz/PlainSummary";
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

type AttemptTheme = "green" | "red" | "blue" | "amber";
/** Plain wording, icon and tone for an attempt state; the raw state stays in the tooltip. */
function attemptInfo(state: string): { label: string; icon: string; theme: AttemptTheme; tone: "green" | "red" | "blue" | "amber" | "gray"; live: boolean } {
  switch (state) {
    case "succeeded": return { label: "worked", icon: "lucide-circle-check", theme: "green", tone: "green", live: false };
    case "failed": return { label: "did not work", icon: "lucide-circle-x", theme: "red", tone: "red", live: false };
    case "partial": return { label: "partly worked", icon: "lucide-circle-alert", theme: "amber", tone: "amber", live: false };
    case "cancelled": case "cancelling": return { label: "was cancelled", icon: "lucide-circle-slash", theme: "blue", tone: "gray", live: false };
    case "declined": return { label: "was declined by the runner", icon: "lucide-circle-slash", theme: "amber", tone: "amber", live: false };
    case "expired": return { label: "timed out", icon: "lucide-timer-off", theme: "amber", tone: "amber", live: false };
    case "outcome_unknown": return { label: "result unknown", icon: "lucide-circle-help", theme: "amber", tone: "amber", live: false };
    case "offered": return { label: "offered to a runner", icon: "lucide-hourglass", theme: "blue", tone: "blue", live: true };
    case "uploading": return { label: "saving its results", icon: "lucide-upload", theme: "blue", tone: "blue", live: true };
    case "verifying": return { label: "being checked", icon: "lucide-shield-check", theme: "blue", tone: "blue", live: true };
    default: return { label: "in progress", icon: "lucide-loader-circle", theme: "blue", tone: "blue", live: true };
  }
}

function attemptSentence(state: string, runnerId: string): string {
  if (state === "succeeded") return `Finished on ${runnerId}.`;
  if (state === "failed") return `Ran on ${runnerId} and stopped with an error.`;
  if (state === "offered") return `Waiting for ${runnerId} to accept it.`;
  return `On ${runnerId}.`;
}

function ageText(createdAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 1000));
  return seconds < 90 ? `${seconds}s` : seconds < 5400 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3600)} h`;
}

/** One sentence for the run's overall condition. */
function runSentence(state: string, attempt: { state: string; number: number } | undefined, attempts: number, reasons: readonly string[]): string {
  if (state === "succeeded") return "This run finished and its result was independently checked.";
  if (state === "failed") return attempts > 1 ? `This run failed after ${attempts} attempts.` : "This run failed. Open the logs to see why.";
  if (state === "cancelled") return "This run was cancelled before it finished.";
  if (state === "outcome_unknown") return "Brain lost contact before the run reported back. Check the target system, then reconcile.";
  if (state === "blocked") return "This run is blocked and needs attention before it can continue.";
  if (state === "queued" || reasons.length > 0) return "This run is waiting for a runner that can take it.";
  if (state === "verifying") return "The work is done and is being independently checked.";
  if (attempt) return `An agent is working on this now (attempt ${attempt.number}).`;
  return "This run has been created and is about to start.";
}

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
  /** A failed, blocked or cancelled run says why in plain words and names the one next action. */
  const problem = (): { theme: "red" | "amber"; title: string; reason: string; next: string } | undefined => {
    const current = state() ?? "";
    if (unknown() || !["failed", "blocked", "cancelled", "expired"].includes(current)) return undefined;
    const last = lastAttempt();
    const where = last ? ` on ${last.runnerId}` : "";
    if (current === "cancelled") return { theme: "amber", title: "This run was stopped", reason: "Someone cancelled it before it finished, so there is no result.", next: "start the task again from its mission if you still need it." };
    if (current === "blocked") return { theme: "amber", title: "This run cannot continue", reason: job()?.queueReasons.length ? queueReasonLabel(job()!.queueReasons) : "It is waiting for something outside the run.", next: "open the Placement tab to see what is missing, then fix it." };
    const why = last?.state === "expired" ? `The runner${where} stopped answering and the attempt timed out.`
      : last?.state === "declined" ? `The runner${where} declined the work.`
      : last ? `The attempt${where} stopped with an error before it produced a verified result.` : "It failed before any attempt could start.";
    return { theme: "red", title: "This run did not work", reason: `${why}${(job()?.attempts.length ?? 0) > 1 ? ` It was tried ${job()!.attempts.length} times.` : ""}`, next: "open View logs below to read what happened, then start the task again from its mission." };
  };
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
        <Show when={problem()}>{(note) => <Alert theme={note().theme} variant="outline" title={note().title} description={`${note().reason} Next: ${note().next}`} />}</Show>
        <Show when={job()?.origin}>{(origin) => origin().kind === "work-item"
          ? <WorkItemLink workspaceId={job()?.workspaceId ?? ""} workItemId={origin().id} class="inline-flex w-fit items-center gap-2 rounded-control text-interface font-medium text-ink-blue-link focus-visible:focus-ring"><span class="lucide-arrow-left size-4" aria-hidden="true" />Back to the mission plan</WorkItemLink>
          : <A class="inline-flex w-fit items-center gap-2 rounded-control text-interface font-medium text-ink-blue-link focus-visible:focus-ring" href={origin().kind === "ticket" ? `/tickets/${origin().id}` : `/incidents/${origin().id}`}><span class="lucide-arrow-left size-4" aria-hidden="true" />Back to the {origin().kind === "ticket" ? "ticket" : "incident"}</A>}</Show>
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
            <CorrelationLink target={{ kind: "logs", workspaceId: job()?.workspaceId ?? "", filters: { job: props.jobId, ...(lastAttempt() ? { attempt: lastAttempt()!.attemptId } : {}), severity: [], emitter: [] } }} label="View logs" icon="lucide-scroll-text" />
            <CorrelationLink target={{ kind: "outputs", workspaceId: job()?.workspaceId ?? "", jobId: props.jobId }} label="Outputs" icon="lucide-package" />
          </fieldset>
        </Show>
        <div class="brain-run-layout">
          <div class="flex min-w-0 flex-col gap-4">
            <TabButtons label="Run inspector" options={TABS} value={tab()} onValueChange={setTab} />
            <Show when={tab() === "summary"}><div class="flex min-w-0 flex-col gap-4">
              <WorkspaceSection title="What is happening" description="The latest authoritative condition, not a model's claim of completion.">
                <PlainSummary icon="lucide-activity">{runSentence(state() ?? "", job()?.attempts.at(-1), job()?.attempts.length ?? 0, job()?.queueReasons ?? [])}</PlainSummary>
                <Show when={latestEvent()} keyed fallback={<Show when={!job()?.queueReasons.length}><p class="text-interface text-ink-gray-7">No engine event has been recorded yet. Placement and attempt details explain the current wait.</p></Show>}>
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
              <Show when={(job()?.attempts.length ?? 0) > 0} fallback={<p class="brain-empty-inline">No attempts recorded yet.</p>}><Timeline items={[...(job()?.attempts ?? [])].map((attempt) => {
                const info = attemptInfo(attempt.state);
                return {
                  id: attempt.attemptId,
                  title: <span class="flex flex-wrap items-center gap-2"><span>Attempt {attempt.number}: {info.label}</span><span title={attempt.state}><StatusIcon state={attempt.state} theme={info.theme} class="size-3.5" /></span></span>,
                  description: <span>{attemptSentence(attempt.state, attempt.runnerId)}{attempt.leaseExpiresAt ? ` ${info.live ? "Its claim on the runner lasts until" : "Its claim ended"} ${formatDateTime(attempt.leaseExpiresAt)}.` : ""}{info.live && job()?.createdAt ? ` Run age ${ageText(job()!.createdAt)}.` : ""}</span>,
                  icon: info.icon,
                  tone: info.tone,
                  timestamp: <Show when={job()?.workspaceId} fallback={<DateText value={attempt.leaseExpiresAt} />}>
                    <span class="flex flex-wrap items-center gap-2"><DateText value={attempt.leaseExpiresAt} />
                      <CorrelationLink target={{ kind: "logs", workspaceId: job()?.workspaceId ?? "", filters: { job: props.jobId, attempt: attempt.attemptId, severity: [], emitter: [] } }} label="View logs" icon="lucide-scroll-text" /></span>
                  </Show>,
                };
              })} /></Show>
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
