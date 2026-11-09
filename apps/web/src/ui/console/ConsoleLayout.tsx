import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "@talelk/newui-atoms";
import type { BrainSession, JobSnapshot } from "@brain/contracts";
import { useApp } from "../app-context";
import { createScopedRead } from "../../data/screens";
import type { StreamEvent } from "../../data/screens";
import { jobsQuery, sessionsQuery } from "../../data/governor";
import { query } from "../../data/client";
import { sessionDetailQuery, type SessionDetail } from "../../data/exec-console";
import { streamContextQuery } from "../../data/exec-logs";
import type { ExecLogFilters } from "../exec/exec-filters";
import { ScreenRegion } from "../screen-region";
import { PaneResizer } from "../components/primitives";import {
  consoleLayout, lastSelectedSession, rememberSelectedSession,
  setRailWidth, setRightWidth,
} from "./ConsoleStore";
import { ConsoleFeed, hydrateConsoleHistory, type FeedEntry } from "./ConsoleFeed";
import { ConsoleInspection, ConsoleToolbar, InterruptionChooser } from "./ConsoleControls";
import { SessionRail } from "./SessionRail";
import { ConsoleNowLine, NO_ACTIVITY, type FeedActivity } from "./NowLine";
import { EmptyState } from "@talelk/newui-molecules";

/**
 * The Live console's three-pane desktop layout (plan §3): a resizable
 * sessions-and-runs rail on the left, the live console in the center (which
 * splits below or beside its record inspection pane), and outputs plus
 * contextual inspection on the right. Pane sizes and the split arrangement
 * persist per workspace in ConsoleStore; below the lg breakpoint the panes
 * stack and the resizers step aside.
 */

const COMPACT_QUERY = "(max-width: 1023px)";

function useCompactMedia(): Accessor<boolean> {
  const [compact, setCompact] = createSignal(typeof window !== "undefined" ? window.matchMedia(COMPACT_QUERY).matches : false);
  onMount(() => {
    const query = window.matchMedia(COMPACT_QUERY);
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    onCleanup(() => query.removeEventListener("change", update));
  });
  return compact;
}

export function ConsoleLayout(props: { workspaceId: string; rail: JSX.Element; center: JSX.Element; right: JSX.Element }): JSX.Element {
  const compact = useCompactMedia();
  const layout = () => consoleLayout(props.workspaceId);
  const resize = (apply: (delta: number) => void) => (delta: number) => { if (!compact()) apply(delta); };
  return <Show
    when={!compact()}
    fallback={<div class="flex flex-col gap-2" style={{ "min-height": "36rem" }}>
      <div class="brain-exec-pane max-h-64 shrink-0 overflow-auto border-b border-outline-gray-1">{props.rail}</div>
      <div class="brain-exec-pane min-h-[28rem] flex-1">{props.center}</div>
      <div class="brain-exec-pane max-h-72 shrink-0 overflow-auto border-t border-outline-gray-1">{props.right}</div>
    </div>}>
    <div class="brain-exec-console w-full" style={{ height: "calc(100dvh - 14rem)", "min-height": "36rem" }}>
      <div class="brain-exec-pane shrink-0" style={{ width: `${layout().railWidth}px` }}>{props.rail}</div>
      <PaneResizer orientation="row" label="Resize the sessions rail (left/right); double-click resets"
        onResize={resize((delta) => setRailWidth(props.workspaceId, layout().railWidth + delta))}
        onReset={() => setRailWidth(props.workspaceId, 288)} />
      <div class="brain-exec-pane min-w-0 flex-1">{props.center}</div>
      <PaneResizer orientation="row" label="Resize the outputs and inspection pane (left/right); double-click resets"
        onResize={resize((delta) => setRightWidth(props.workspaceId, layout().rightWidth - delta))}
        onReset={() => setRightWidth(props.workspaceId, 320)} />
      <div class="brain-exec-pane shrink-0" style={{ width: `${layout().rightWidth}px` }}>{props.right}</div>
    </div>
  </Show>;
}

/**
 * The full console screen shared by `/w/:id/live` and `/sessions/:id` — active
 * versus historical sessions are state and available controls, never two
 * different layouts. Selection lives in the URL (the page passes it in and
 * receives changes back), so deep links restore the exact console.
 */
export function ConsoleScreen(props: {
  workspaceId: string;
  requestedSession?: string;
  filters: ExecLogFilters;
  onFiltersChange: (patch: Partial<ExecLogFilters>) => void;
  onSessionChange: (sessionId: string | undefined) => void;
  /** Limits the console to some sessions, e.g. one mission's or one member's. */
  include?: (session: BrainSession) => boolean;
}): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const ws = () => props.workspaceId;

  const sessions = createScopedRead<BrainSession[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await sessionsQuery({ workspaceId: scope.workspaceId }, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    refreshMs: 5_000,
  });
  const jobs = createScopedRead<JobSnapshot[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await jobsQuery({ workspaceId: scope.workspaceId, limit: 25 }, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    refreshMs: 10_000,
  });

  const visible = () => (sessions.state().data ?? []).filter((session) => props.include?.(session) ?? true);
  // Selection: URL first, then the persisted fallback, then the most relevant
  // live session. Every change is written back through onSessionChange.
  const selected = createMemo(() => props.requestedSession ?? lastSelectedSession(ws()) ?? "");
  createEffect(() => {
    const items = visible();
    if (!items?.length) return;
    const current = selected();
    if (current && items.some((item) => item.sessionId === current)) {
      rememberSelectedSession(ws(), current);
      return;
    }
    const preferred = items.find((item) => item.state === "running")
      ?? items.find((item) => item.state === "starting" || item.state === "waiting")
      ?? items[0]!;
    rememberSelectedSession(ws(), preferred.sessionId);
    props.onSessionChange(preferred.sessionId);
  });

  const rail = <SessionRail workspaceId={ws()} sessions={visible()} jobs={jobs.state().data ?? []}
    selected={selected() || undefined} onSelect={(sessionId) => props.onSessionChange(sessionId)}
    onOpenRun={(jobId) => void navigate(`/runs/${jobId}`)}
    onOpenRunsIndex={() => void navigate(`/w/${ws()}/logs`)} />;

  return <div class="flex min-h-0 flex-col">
    <Show when={selected()} keyed fallback={
      <ScreenRegion state={sessions.state()} skeleton="rows" emptyTitle="No sessions yet"
        emptyDescription="Sessions appear here the moment a run claims a runner. Dispatch declared work to start one."
        emptyAction={<Button variant="solid" theme="blue" onClick={() => void navigate(`/w/${ws()}/plays`)}>Start work</Button>}
        onRetry={() => void sessions.refresh({ force: true })}>
        <EmptyState size="sm" icon="lucide-radio" title="The execution console is ready"
          description="Live sessions, their tool activity and their outputs will stream in this three-pane console." />
      </ScreenRegion>}>
      {(sessionId) => <SessionConsole workspaceId={ws()} sessionId={sessionId} rail={rail}
        jobs={jobs.state().data ?? []} filters={props.filters} onFiltersChange={props.onFiltersChange}
        onSessionChange={props.onSessionChange} />}
    </Show>
  </div>;
}

/** One selected session's console: toolbar + feed in the center, inspection right. */
function SessionConsole(props: {
  workspaceId: string;
  sessionId: string;
  rail: JSX.Element;
  jobs: readonly JobSnapshot[];
  filters: ExecLogFilters;
  onFiltersChange: (patch: Partial<ExecLogFilters>) => void;
  onSessionChange: (sessionId: string | undefined) => void;
}): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const session = createScopedRead<SessionDetail>({
    scope: app.scope,
    resource: () => props.sessionId,
    load: (scope, signal, resource) => sessionDetailQuery(scope.workspaceId, resource!, signal),
    refreshMs: 5_000,
  });
  const detail = createMemo(() => session.state().data);
  const boundJob = createMemo(() => props.jobs.find((job) => job.jobId === detail()?.jobId));

  // Bounded history hydration; the feed's SSE channel seeds from its head.
  // Severity/emitter filters reshape the whole transcript, so they re-hydrate;
  // a stream reset (cursor lag) bumps the same reload counter.
  const [history, setHistory] = createSignal<readonly StreamEvent[]>([]);
  const [head, setHead] = createSignal(0);
  const [epoch, setEpoch] = createSignal(0);
  const [hydrating, setHydrating] = createSignal(true);
  const [reload, setReload] = createSignal(0);
  const filterSignature = () => `${props.filters.severity.join(",")}|${props.filters.emitter.join(",")}`;
  createEffect(() => {
    filterSignature();
    reload();
    const controller = new AbortController();
    setHydrating(true);
    void hydrateConsoleHistory(props.workspaceId, props.sessionId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setHistory(result.frames);
        setHead(result.head);
        setEpoch((value) => value + 1);
        setHydrating(false);
      })
      .catch(() => { if (!controller.signal.aborted) setHydrating(false); });
    onCleanup(() => controller.abort());
  });

  const [feedback, setFeedback] = createSignal("");
  const [selectedEntry, setSelectedEntry] = createSignal<FeedEntry | undefined>();
  const [resolveToken, setResolveToken] = createSignal(0);
  const [inspectToken, setInspectToken] = createSignal(0);
  const [approvalId, setApprovalId] = createSignal<string | undefined>();
  const [activity, setActivity] = createSignal<FeedActivity>(NO_ACTIVITY);

  const canOperate = () => app.canDispatch() && session.state().canMutate;

  async function findApproval(): Promise<void> {
    const entry = selectedEntry();
    if (!entry) { setFeedback("Select a tool call or effect record in the feed to resolve its approval."); return; }
    try {
      const loaded = await streamContextQuery(entry.event.eventId ?? entry.event.id);
      const linked = loaded.snapshot.approval?.approvalId;
      if (linked) { setApprovalId(linked); setFeedback(""); }
      else setFeedback("No approval is linked to this record's invocation.");
    } catch (e) {
      setFeedback(e instanceof Error ? e.message : "The approval linkage could not be resolved.");
    }
  }

  function resumePayload(current: SessionDetail) {
    // session.create requires the full prior-session authority; resume only
    // adds resumeFromSessionId (not a single-field call — plan §1).
    return {
      workItemId: current.workItemId!,
      agentId: current.agentId,
      engineId: current.engine.id,
      task: current.task,
      budget: { maxTokens: current.budget.maxTokens, maxMicroUsd: current.budget.maxMicroUsd, maxTurns: current.budget.maxTurns },
      scope: {
        allowedPaths: [...current.scope.allowedPaths],
        prohibitedPaths: [...current.scope.prohibitedPaths],
        allowedTools: [...current.scope.allowedTools],
      },
      worktreeId: current.worktreeId,
      resumeFromSessionId: current.sessionId,
    };
  }

  const center = <div class="flex min-h-0 flex-1 flex-col">
    <ConsoleNowLine session={detail()} activity={activity()} />
    <ConsoleToolbar workspaceId={props.workspaceId} sessionId={props.sessionId}
      session={detail()} canOperate={canOperate()} feedback={feedback()} selected={selectedEntry()}
      onRefresh={() => void session.refresh({ force: true })}
      onSteer={async (message) => {
        try {
          const result = await app.run("session.steer", { sessionId: props.sessionId, message });
          setFeedback(result.detail);
        } catch (e) { setFeedback(e instanceof Error ? e.message : "Steering was refused."); }
      }}
      onStop={async (reason) => {
        try {
          const result = await app.run("session.stop", { sessionId: props.sessionId, reason });
          setFeedback(result.detail);
          await session.refresh({ force: true });
        } catch (e) { setFeedback(e instanceof Error ? e.message : "Stop was refused."); }
      }}
      onAttach={async (body) => {
        const current = detail();
        if (!current?.workItemId) { setFeedback("This session has no work item to attach context to."); return; }
        try {
          const item = await query<{ snapshot: { missionId: string } }>({ queryType: "workItems.get", workspaceId: app.scope().workspaceId, resourceId: current.workItemId });
          const result = await app.run("mission.message.send", { missionId: item.snapshot.missionId, recipient: { kind: "mission" }, workItemId: current.workItemId, body });
          setFeedback(result.detail);
        } catch (e) { setFeedback(e instanceof Error ? e.message : "Attaching context was refused."); }
      }}
      onOpenToolResult={() => setResolveToken((value) => value + 1)}
      onInspectOutput={() => setInspectToken((value) => value + 1)}
      onFindApproval={() => findApproval()} />
    <Show when={detail()} keyed>
      {(current) => <InterruptionChooser session={current} canOperate={canOperate()}
        onResume={async () => {
          try {
            const result = await app.run("session.create", resumePayload(current));
            setFeedback(result.detail);
            if (result.resourceId) props.onSessionChange(result.resourceId);
          } catch (e) { setFeedback(e instanceof Error ? e.message : "The resume was refused."); }
        }}
        onReconcile={async (reason) => {
          if (!current.jobId) { setFeedback("No run is bound to this session."); return; }
          try {
            const result = await app.run("job.reconcile", { jobId: current.jobId, reason });
            setFeedback(result.detail);
          } catch (e) { setFeedback(e instanceof Error ? e.message : "Reconciliation was refused."); }
        }}
        onRestart={() => {
          // Restart dispatches through the Start work flow, which validates the
          // workflow input schema — the console does not blind-dispatch. The
          // session's work item rides along as the entry origin, so the flow
          // opens this task with its current input for review (TaskEntry reads
          // originKind/originId), never a blank catalog.
          const target = current.workItemId
            ? `/w/${props.workspaceId}/plays?originKind=work-item&originId=${encodeURIComponent(current.workItemId)}`
            : `/w/${props.workspaceId}/plays`;
          setFeedback("Restart opens the Start work flow with this task and its inputs for a schema-validated dispatch.");
          void navigate(target);
        }} />}
    </Show>
    <Show when={hydrating() ? undefined : { epoch: epoch(), head: head(), history: history() }} keyed
      fallback={<p role="status" class="px-3 py-2 text-caption text-ink-gray-6">Loading the session transcript…</p>}>
      {(ready) => <ConsoleFeed workspaceId={props.workspaceId} sessionId={props.sessionId}
        streamCursor={ready.head || (detail()?.streamCursor ?? 0)} history={ready.history}
        filters={props.filters} onFiltersChange={props.onFiltersChange}
        onResync={() => setReload((value) => value + 1)}
        resolveToken={resolveToken()} onSelectionChange={setSelectedEntry} onActivity={setActivity} />}
    </Show>
  </div>;

  const right = <ConsoleInspection workspaceId={props.workspaceId} scope={app.scope}
    session={detail()} job={boundJob()} approvalId={approvalId()} inspectToken={inspectToken()} />;

  return <ConsoleLayout workspaceId={props.workspaceId} rail={props.rail} center={center} right={right} />;
}
