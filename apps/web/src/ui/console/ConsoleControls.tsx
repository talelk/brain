import { For, Show, createEffect, createSignal, on } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { Button, Textarea } from "@talelk/newui-atoms";
import type { ArtifactRef, JobSnapshot } from "@brain/contracts";
import { createScopedRead } from "../../data/screens";
import { artifactsListQuery } from "../../data/exec-outputs";
import type { SessionContinuation, SessionDetail } from "../../data/exec-console";
import { execLogsUrl } from "../exec/exec-filters";
import { CorrelationLink } from "../exec/CorrelationLink";
import { WorkItemLink } from "../exec/WorkItemLink";
import { ArtifactView } from "../outputs/ArtifactView";
import { EvidenceList } from "../components/EvidenceList";
import { ReasonDialog } from "../components/ReasonDialog";
import { StatusBadge } from "../components/StatusBadge";
import { RelativeTime } from "../screen-region";
import { formatUsd } from "../format";

/** The read scope every contextual panel reads through (no fabricated scopes). */
type ConsoleScope = Accessor<{ organizationId: string; workspaceId: string; generation: number }>;

/**
 * The console's intervention surface (plan §3 action → command map, exact):
 * Steer → session.steer; Stop → session.stop; Attach context →
 * mission.message.send for the session's work item. A tool call's result and
 * approval linkage open on its card in the transcript. After an interruption the
 * chooser names exactly one recovery operation (reconnect / continue native /
 * resume from verified checkpoint / restart / reconcile) — they are not
 * interchangeable, and the UI enables only the commands that exist.
 */

export function ConsoleToolbar(props: {
  workspaceId: string;
  sessionId: string;
  session?: SessionDetail;
  canOperate: boolean;
  feedback: string;
  /** Bumped to open the steering form, e.g. from an inline request for input. */
  steerRequest?: number;
  /** The session works a mission task, so a steer is recorded in the mission brief even when the engine cannot be redirected. */
  recordsSteer?: boolean;
  /** The mission's state when known; Pause and Resume act on the whole mission. */
  missionState?: "active" | "paused" | string;
  onPause?: () => Promise<void>;
  onResume?: () => Promise<void>;
  onRefresh: () => void;
  onSteer: (message: string) => Promise<void>;
  onStop: (reason: string) => Promise<void>;
  onAttach: (body: string) => Promise<void>;
}): JSX.Element {
  const [dialog, setDialog] = createSignal<"none" | "steer" | "stop" | "attach" | "reconcile">("none");
  const [reason, setReason] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const session = () => props.session;
  const terminal = () => session()?.state === "stopping" || session()?.state === "stopped" || session()?.state === "failed";
  const live = () => session()?.state === "running" || session()?.state === "starting" || session()?.state === "waiting";
  const features = () => session()?.engine.features ?? [];
  const engineSteers = () => features().includes("steer");
  const canSteer = () => live() && props.canOperate && (engineSteers() || Boolean(props.recordsSteer));
  const canPause = () => live() && props.canOperate && props.missionState === "active" && Boolean(props.onPause);
  const canResume = () => props.canOperate && props.missionState === "paused" && Boolean(props.onResume);
  const canStop = () => !terminal() && props.canOperate;
  const canAttach = () => (live() || terminal()) && props.canOperate && !!session()?.workItemId;
  createEffect(on(() => props.steerRequest ?? 0, (token) => { if (token > 0 && canSteer()) { setDialog("steer"); setReason(""); } }, { defer: true }));

  async function submit(kind: "steer" | "stop" | "attach"): Promise<void> {
    setBusy(true);
    try {
      if (kind === "steer" && reason().trim()) await props.onSteer(reason().trim());
      if (kind === "stop" && reason().trim()) await props.onStop(reason().trim());
      if (kind === "attach" && reason().trim()) await props.onAttach(reason().trim());
      setDialog("none"); setReason("");
    } finally { setBusy(false); }
  }

  return <div class="flex flex-col gap-2 border-b border-outline-gray-1 px-3 py-2.5">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div class="flex min-w-0 flex-1 basis-72 items-center gap-2.5">
        <span class="grid size-8 shrink-0 place-items-center rounded-full bg-surface-blue-2 text-ink-blue-8" aria-hidden="true"><span class="lucide-bot size-4" /></span>
        <div class="min-w-0">
          <div class="flex min-w-0 items-center gap-2">
            <h2 class="min-w-0 truncate text-base-medium text-ink-gray-9" title={session()?.task || props.sessionId}>{session()?.task || `${session()?.agentId ?? "Agent"} session`}</h2>
            <StatusBadge status={session()?.state ?? "unknown"} />
          </div>
          <p class="truncate text-caption text-ink-gray-6" title="The engine decides which controls exist">
            {[session()?.agentId, session()?.engine.id ?? "engine unavailable"].filter((part) => part && part !== "unknown").join(" · ")}<Show when={features().length > 0}> ({features().join(", ")})</Show>
          </p>
        </div>
      </div>
      <div class="ms-auto flex flex-wrap items-center gap-1">
        <Show when={canPause()}>
          <Button size="sm" variant="outline" iconLeft="lucide-pause" title="Pause the whole mission: no new task starts until you resume" disabled={busy()}
            onClick={() => { setBusy(true); void props.onPause?.().finally(() => setBusy(false)); }}>Pause</Button>
        </Show>
        <Show when={canResume()}>
          <Button size="sm" variant="outline" theme="blue" iconLeft="lucide-play" title="Resume the paused mission" disabled={busy()}
            onClick={() => { setBusy(true); void props.onResume?.().finally(() => setBusy(false)); }}>Resume</Button>
        </Show>
        <Show when={canSteer()}>
          <Button size="sm" variant="outline" theme="blue" iconLeft="lucide-corner-down-right"
            title={engineSteers() ? "Saved to the mission brief, then applied at the agent's next turn" : "Saved to the mission brief; applies from the next task"} onClick={() => { setDialog("steer"); setReason(""); }}>
            Steer{session()?.continuation.reconnectable ? " (reconnect)" : ""}
          </Button>
        </Show>
        <Show when={canAttach()}>
          <Button size="sm" variant="outline" iconLeft="lucide-paperclip" aria-label="Attach context" onClick={() => { setDialog("attach"); setReason(""); }}>Attach</Button>
        </Show>
        <Show when={canStop()}>
          <Button size="sm" variant="outline" theme="red" iconLeft="lucide-square" onClick={() => { setDialog("stop"); setReason(""); }}>Stop</Button>
        </Show>
        <Button size="sm" variant="ghost" iconLeft="lucide-refresh-cw" aria-label="Refresh session" onClick={props.onRefresh} />
        <a class="inline-flex items-center gap-1 rounded-control px-1.5 py-1 text-caption text-ink-blue-link hover:bg-surface-blue-1 focus-visible:focus-ring" aria-label="View logs for this session"
          title="Open the full log of this session"
          href={execLogsUrl(props.workspaceId, { session: props.sessionId, severity: [], emitter: [] })}><span class="lucide-scroll-text size-3.5" aria-hidden="true" />View logs</a>
      </div>
    </div>
    <Show when={terminal()}><p class="text-caption text-ink-gray-6">This session is stopping or has ended, so it can no longer be steered.</p></Show>
    <Show when={!canSteer() && live()}><p class="text-caption text-ink-gray-6" title={`Engine features: ${features().length > 0 ? features().join(", ") : "none"}`}>This agent cannot be redirected while it works.</p></Show>
    <Show when={props.feedback}><p role="status" class="text-caption text-ink-gray-7">{props.feedback}</p></Show>

    <Show when={dialog() === "steer"}>
      <div class="rounded-control border border-outline-blue-2 bg-surface-blue-1 p-3">
        <Textarea label="Steering message" value={reason()} placeholder="Add context or redirect the next step…"
          onInput={(event) => setReason(event.currentTarget.value)} />
        <div class="mt-2 flex items-center gap-2">
          <Button size="sm" variant="solid" theme="blue" disabled={!reason().trim() || busy()} loading={busy()} onClick={() => void submit("steer")}>Send steering</Button>
          <span class="text-caption text-ink-gray-6">{props.recordsSteer ? (engineSteers() ? "Saved to the mission brief as a constraint, then applied at the agent's next turn. Not a rewrite of past turns." : "Saved to the mission brief as a constraint. This agent cannot be redirected while it works, so it applies from its next task.") : "Applies at the engine's next turn boundary, not a rewrite of past turns."}</span>
        </div>
      </div>
    </Show>
    <Show when={dialog() === "attach"}>
      <div class="rounded-control border border-outline-gray-2 bg-surface-gray-1 p-3">
        <Textarea label="Context for the work item and session" value={reason()} placeholder="Paste the exact context the agent should use…"
          onInput={(event) => setReason(event.currentTarget.value)} />
        <div class="mt-2 flex items-center gap-2">
          <Button size="sm" variant="solid" theme="blue" disabled={!reason().trim() || busy()} loading={busy()} onClick={() => void submit("attach")}>Attach to work item</Button>
          <span class="text-caption text-ink-gray-6">A mission message for this work item; it reaches the session live when the engine can be steered, otherwise when its next session starts.</span>
        </div>
      </div>
    </Show>
    <ReasonDialog open={dialog() === "stop"} onClose={() => setDialog("none")}
      title="Stop this session" description="Stopping is an authoritative command. A named reason is recorded against the exact session."
      reason={reason()} onReason={setReason} reasonLabel="Stop reason" confirmLabel="Stop session" tone="red" busy={busy()}
      onConfirm={(value) => { setReason(value); void submit("stop"); }} />
  </div>;
}

/** Exactly one suggested recovery operation, derived from server continuation facts. */
export function interruptionOperation(continuation: SessionContinuation): {
  operation: "continue-native" | "resume-checkpoint" | "restart" | "reconcile" | "none";
  label: string; description: string; command: string;
} {
  if (continuation.reconcileRequired) {
    return {
      operation: "reconcile", command: "job.reconcile",
      label: "Reconcile the unknown external effect",
      description: "The run ended with an unknown outcome and unresolved effects. Reconcile against the target system before any retry — resume and restart are intentionally unavailable until this is settled.",
    };
  }
  if (continuation.continueNative && continuation.resumable) {
    return {
      operation: "continue-native", command: "session.create (resumeFromSessionId)",
      label: "Continue the native session",
      description: "The engine advertises native resume and a verified checkpoint exists. Brain continues the same session under the harness and pinned version that recorded the checkpoint.",
    };
  }
  if (continuation.resumable) {
    return {
      operation: "resume-checkpoint", command: "session.create (resumeFromSessionId)",
      label: "Resume from the verified checkpoint as a new attempt",
      description: "A verified checkpoint exists and no live attempt holds the session. Brain resumes a new attempt from it — it does not reconnect to the old process.",
    };
  }
  if (continuation.restartable) {
    return {
      operation: "restart", command: "workflow.dispatch",
      label: "Restart the task as a new dispatch",
      description: "No checkpoint applies. Brain dispatches the task again as a new run through the Start work flow, which validates the workflow input schema.",
    };
  }
  return {
    operation: "none", command: "—",
    label: "No recovery operation applies",
    description: "The session is closed with no verified checkpoint, its work item cannot be re-dispatched, and no unknown effect awaits reconciliation.",
  };
}

export function InterruptionChooser(props: {
  session: SessionDetail;
  canOperate: boolean;
  onResume: () => Promise<void>;
  onReconcile: (reason: string) => Promise<void>;
  onRestart: () => void;
}): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [dialog, setDialog] = createSignal<"none" | "reconcile">("none");
  const [reason, setReason] = createSignal("");
  const [feedback, setFeedback] = createSignal("");
  const suggested = () => interruptionOperation(props.session.continuation);
  const actionable = () => props.canOperate && suggested().operation !== "none"
    && (suggested().operation !== "continue-native" && suggested().operation !== "resume-checkpoint" || !!props.session.workItemId);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    try { await action(); } finally { setBusy(false); }
  }

  // Only a session that actually ended badly is an "interruption". A healthy
  // running session, or one that finished normally with nothing to recover,
  // shows no banner at all.
  const interrupted = () => {
    const { state, continuation } = props.session;
    if (state === "failed") return true;
    if (state === "starting" || state === "waiting" || state === "running" && continuation.reconnectable) return false;
    return suggested().operation !== "none";
  };
  return <Show when={interrupted()}>
    <div class="border-b border-outline-gray-1 bg-surface-amber-1 px-3 py-2">
      <div class="flex flex-wrap items-center gap-2">
        <span class="lucide-heart-crack size-4 text-ink-amber-8" aria-hidden="true" />
        <strong class="text-caption font-medium text-ink-gray-9">{props.session.state === "failed" ? "This session failed." : "This session was interrupted."} {suggested().operation === "none" ? suggested().label : `Suggested next step: ${suggested().label}`}</strong>
        <Show when={actionable()}>
          <Button size="sm" variant="solid" theme="blue" disabled={busy()} loading={busy() && suggested().operation !== "restart"}
            onClick={() => {
              if (suggested().operation === "restart") { props.onRestart(); return; }
              if (suggested().operation === "reconcile") { setDialog("reconcile"); return; }
              void run(props.onResume);
            }}>{suggested().label}</Button>
        </Show>
      </div>
      <p class="mt-1 text-caption text-ink-gray-6">{suggested().description}</p>
      <Show when={!actionable() && suggested().operation !== "none"}>
        <p class="mt-1 text-caption text-ink-gray-6">This operation needs an operator authorization{props.session.workItemId ? "" : " and a work item binding (the resume payload requires it)"}.</p>
      </Show>
      <Show when={feedback()}><p role="status" class="mt-1 text-caption text-ink-gray-7">{feedback()}</p></Show>
      <ReasonDialog open={dialog() === "reconcile"} onClose={() => setDialog("none")}
        title="Reconcile the unknown outcome" description="A named reason is recorded against the exact run and cannot be empty."
        reason={reason()} onReason={setReason} reasonLabel="Reconciliation reason" confirmLabel="Request reconciliation" busy={busy()}
        onConfirm={(value) => {
          setReason(value);
          void run(async () => { await props.onReconcile(value); setDialog("none"); setFeedback("Reconciliation request recorded."); });
        }} />
    </div>
  </Show>;
}

/** Evidence exists only once the work has ended; while it runs, "no evidence" is expected, not a problem. */
const checkable = (job: JobSnapshot | undefined, session: SessionDetail | undefined): boolean =>
  !!job?.evidenceDigest || session?.state === "stopped" || session?.state === "failed"
  || ["succeeded", "failed", "cancelled", "outcome_unknown"].includes(job?.runState ?? job?.state ?? "");

/** Right pane: the session's facts and usage, its outputs, and the independent verification. */
export function ConsoleInspection(props: {
  workspaceId: string;
  scope: ConsoleScope;
  session?: SessionDetail;
  job?: JobSnapshot;
}): JSX.Element {
  const [previewId, setPreviewId] = createSignal<string | undefined>();
  const scopeFilter = () => props.session?.jobId ? { jobId: props.session.jobId } : props.session?.workItemId ? { workItemId: props.session.workItemId } : undefined;
  const artifacts = createScopedRead<{ items: readonly { artifactId: string; digest: string; bytes: number; mediaType: string; classification: string }[] }>({
    scope: props.scope,
    // Re-read when the session's producer binding (run or work item) changes.
    resource: () => props.session?.jobId ?? props.session?.workItemId ?? "",
    load: async (_scope, signal) => {
      const filter = scopeFilter();
      if (!filter) return { snapshot: { items: [] }, asOf: "", sourceWatermark: 0 };
      const loaded = await artifactsListQuery({ workspaceId: props.workspaceId, ...filter }, signal);
      return { ...loaded, snapshot: { items: [...loaded.snapshot.items] } };
    },
    refreshMs: 15_000,
  });
  const previewed = () => artifacts.state().data?.items.find((item) => item.artifactId === previewId());
  const tokenShare = () => {
    const max = props.session?.budget.maxTokens ?? 0;
    return max > 0 ? Math.min(100, Math.round(((props.session?.usedTokens ?? 0) / max) * 100)) : 0;
  };
  const fileIcon = (mediaType: string) => mediaType.startsWith("image/") ? "lucide-image" : mediaType.includes("json") ? "lucide-braces" : mediaType.startsWith("text/") ? "lucide-file-text" : "lucide-file";

  return <div class="brain-exec-scroll flex flex-col gap-4 p-3" data-testid="console-inspection">
    <section class="flex flex-col gap-2.5" aria-label="Session facts">
      <h3 class="text-base-medium text-ink-gray-9">Session</h3>
      <div class="flex flex-col gap-1.5 rounded-card border border-outline-gray-1 p-2.5">
        <div class="flex items-center justify-between gap-2 text-caption">
          <span class="text-ink-gray-6">Tokens</span>
          <span class="tabular-nums text-ink-gray-9">{(props.session?.usedTokens ?? 0).toLocaleString("en-GB")} of {(props.session?.budget.maxTokens ?? 0).toLocaleString("en-GB")}</span>
        </div>
        <span role="progressbar" aria-label="Tokens used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={tokenShare()} class="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-gray-3">
          <span class={`h-full ${tokenShare() >= 90 ? "bg-surface-amber-6" : "bg-surface-blue-9"}`} style={{ width: `${tokenShare()}%` }} />
        </span>
        <div class="flex items-center justify-between gap-2 text-caption">
          <span class="text-ink-gray-6">Cost so far</span><span class="tabular-nums text-ink-gray-9">{formatUsd(props.session?.usedMicroUsd)}</span>
        </div>
      </div>
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-caption">
        <dt class="text-ink-gray-6">State</dt><dd class="min-w-0"><StatusBadge status={props.session?.state ?? "unknown"} /></dd>
        <dt class="text-ink-gray-6">Engine</dt><dd class="min-w-0 break-words text-ink-gray-9">{props.session?.engine.id ?? "—"} {props.session?.engine.version ?? ""}</dd>
        <dt class="text-ink-gray-6">Turn limit</dt><dd class="min-w-0 text-ink-gray-9">{props.session?.budget.maxTurns ?? "—"} turns</dd>
        <Show when={props.session?.workItemId}><dt class="text-ink-gray-6">Work item</dt><dd class="min-w-0 break-all"><WorkItemLink workspaceId={props.workspaceId} workItemId={props.session!.workItemId!} class="text-ink-blue-link hover:underline focus-visible:focus-ring">{props.session!.workItemId}</WorkItemLink></dd></Show>
        <Show when={props.session?.jobId}><dt class="text-ink-gray-6">Run</dt><dd class="min-w-0"><CorrelationLink target={{ kind: "job", jobId: props.session!.jobId! }} label={props.session!.jobId!} icon="lucide-workflow" class="max-w-full" /></dd></Show>
        <dt class="text-ink-gray-6">Updated</dt><dd class="min-w-0 text-ink-gray-9"><RelativeTime value={props.session?.updatedAt} /></dd>
      </dl>
    </section>

    <section class="flex flex-col gap-2" aria-label="Working outputs">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-base-medium text-ink-gray-9">Outputs</h3>
        <Show when={scopeFilter()}>
          <a class="text-caption text-ink-blue-link hover:underline focus-visible:focus-ring" href={`/w/${props.workspaceId}/outputs?${props.session?.jobId ? `job=${props.session.jobId}` : `workItem=${props.session?.workItemId}`}`}>Open in Outputs</a>
        </Show>
      </div>
      <Show when={(artifacts.state().data?.items.length ?? 0) > 0} fallback={
        <p class="text-caption text-ink-gray-6">{scopeFilter() ? "No file yet. Files bind here as the session produces them, each with its digest and verification." : "This session is not bound to a run or work item, so it has no outputs to show."}</p>}>
        <div class="flex flex-col gap-1">
          <For each={artifacts.state().data?.items.slice(0, 12)}>{(artifact) => (
            <button type="button" aria-pressed={previewId() === artifact.artifactId}
              class={`flex w-full cursor-pointer items-center gap-2 rounded-control border px-2 py-1.5 text-start text-caption focus-visible:focus-ring ${previewId() === artifact.artifactId ? "border-outline-blue-2 bg-surface-blue-1" : "border-outline-gray-1 hover:bg-surface-gray-1"}`}
              onClick={() => setPreviewId((current) => (current === artifact.artifactId ? undefined : artifact.artifactId))}>
              <span class={`${fileIcon(artifact.mediaType)} size-3.5 shrink-0 text-ink-gray-6`} aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-ink-gray-8" title={artifact.digest}>{artifact.mediaType}</span>
              <span class="shrink-0 tabular-nums text-ink-gray-6">{artifact.bytes.toLocaleString("en-GB")} B</span>
            </button>
          )}</For>
        </div>
        <Show when={previewed()} keyed>{(artifact) => <div class="rounded-control border border-outline-gray-1 p-2">
          <ArtifactView artifact={artifact as unknown as ArtifactRef} compact />
        </div>}</Show>
      </Show>
    </section>

    <Show when={props.job && !checkable(props.job, props.session)}>
      <p class="flex items-start gap-1.5 rounded-control bg-surface-gray-1 px-2.5 py-2 text-caption text-ink-gray-7">
        <span class="lucide-shield-check mt-0.5 size-3.5 shrink-0" aria-hidden="true" />Independent checking of the result starts when this work finishes.
      </p>
    </Show>
    <Show when={props.job && checkable(props.job, props.session)}>
      <section class="flex flex-col gap-2" aria-label="Verification">
        <h3 class="text-base-medium text-ink-gray-9">Verification</h3>
        <EvidenceList bundleDigest={props.job!.evidenceDigest} workspaceId={props.workspaceId}
          emptyHint="No evidence bundle is bound to this run yet. Independent verification — not agent output — decides completion." />
      </section>
    </Show>
  </div>;
}
