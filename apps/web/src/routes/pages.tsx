import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import type {
  ApprovalRequest, AuditEntry, BoardView, ConfigExplanation, DecisionHistoryEntry, DeliveryDossier, HealthView,
  IncidentDetail, IncidentSummary, JobSnapshot, MemoryResult, MemberGrantView, PlacementExplanation, RunnerSnapshot,
  SessionView, SLASummary, TicketDetail, TicketSummary, TodayItem, ToolCatalogEntry, WorkspaceContext, WorkspaceSummary,
} from "@brain/contracts";
import { useApp } from "../ui/app-context";
import { createScopedRead } from "../data/screens";
import { governor } from "../data/client";
import {
  approvalQuery, approvalsQuery, auditQuery, boardQuery, bridgeQuery, configExplainQuery, decisionsQuery,
  deliveryQuery, healthQuery, incidentQuery, incidentsQuery, jobExplainQuery, jobQuery, jobsQuery,
  membersQuery, memorySearchQuery, runnerQuery, runnersQuery, sessionQuery, sessionsQuery, slaQuery,
  ticketQuery, ticketsQuery, todayQuery, toolsQuery, workspaceContextQuery,
} from "../data/governor";
import { TodayScreen, BridgeScreen } from "./today";
import { BoardScreen, DecisionsScreen, SupportScreen, SreScreen, DeliveryScreen } from "./work";
import { ApprovalsScreen, ApprovalDetailScreen } from "./approvals";
import { RunsScreen } from "./runs";
import { KnowledgeScreen, ToolsScreen, type MemoryPublicationInput, type ToolProposalInput } from "./knowledge";
import { SettingsScreen } from "./settings";
import { WorkspaceOverview, RunnerDetailScreen, TicketDetailScreen, IncidentDetailScreen } from "./workspace";
import { RunDetail } from "../ui/components/RunDetail";
import { SessionFeed } from "../ui/components/SessionFeed";

/**
 * One page component per contract route. Pages own no authority: they render
 * server snapshots through the screen compositions and send explicit commands
 * through the app context. Scope changes (workspace switch, revocation) clear
 * every read through `createScopedRead`.
 */

/** Resolves the workspace a detail page binds to (route id, current, or first readable). */
function useDetailWorkspace(): () => string {
  const app = useApp();
  return () => app.workspaceId() || app.identity()?.workspaces[0]?.workspaceId || "";
}

function TodayPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const today = createScopedRead<TodayItem[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await todayQuery({ workspaceId: scope.workspaceId }, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 15_000,
  });
  return <TodayScreen items={today.state().data ?? []} state={today.state()} asOf={today.state().asOf}
    onRefresh={() => void today.refresh({ force: true })}
    onOpen={(item) => {
      if (item.type === "approval") void navigate(`/approvals/${item.resourceId}`);
      else if (item.type === "job") void navigate(`/jobs/${item.resourceId}`);
      else if (item.type === "incident") void navigate(`/incidents/${item.resourceId}`);
      else if (item.type === "sla") void navigate(`/w/${item.workspaceId}/support`);
      else void navigate(`/w/${item.workspaceId}/decisions`);
    }} />;
}

function BridgePage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const bridge = createScopedRead<WorkspaceSummary[]>({
    scope: app.scope,
    load: async (_scope, signal) => {
      const loaded = await bridgeQuery({}, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (workspaces) => workspaces.length === 0,
    refreshMs: 30_000,
  });
  return <BridgeScreen workspaces={bridge.state().data ?? []} state={bridge.state()}
    onRefresh={() => void bridge.refresh({ force: true })}
    onOpen={(workspaceId) => { app.selectWorkspace(workspaceId); void navigate(`/w/${workspaceId}/overview`); }} />;
}

function WorkspaceOverviewPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const context = createScopedRead<WorkspaceContext>({
    scope: app.scope,
    load: (scope, signal) => workspaceContextQuery(scope.workspaceId, signal),
    refreshMs: 30_000,
  });
  const workflows = createScopedRead<string[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await configExplainQuery(scope.workspaceId, "/workflows", signal);
      const effective = loaded.snapshot.effective;
      const ids = effective && typeof effective === "object" && !Array.isArray(effective) ? Object.keys(effective) : [];
      return { ...loaded, snapshot: ids };
    },
    isEmpty: (ids) => ids.length === 0,
  });
  const [actionMessage, setActionMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <Show when={actionMessage()}><p role="status" class="text-base text-ink-gray-7">{actionMessage()}</p></Show>
    <WorkspaceOverview workspaceId={app.workspaceId()} context={context.state().data}      workflows={workflows.state().data ?? []} canDispatch={app.canDispatch()}
      state={context.state()} onRefresh={() => void context.refresh({ force: true })}
      blockedReason={context.state().canMutate ? undefined
        : context.state().error ?? "The workspace view is not fresh; re-read before dispatching an effect."}
      onDispatch={async (workflowId, input) => {
        try {
          const release = context.state().data?.release;
          const result = await app.run("workflow.dispatch", {
            workflow: { id: workflowId, digest: release?.configDigest ?? "" },
            input,
          });
          setActionMessage(result.detail);
          if (result.accepted && result.resourceId) void navigate(`/jobs/${result.resourceId}`);
          await context.refresh({ force: true });
        } catch (e) { setActionMessage(e instanceof Error ? e.message : "Dispatch failed."); }
      }} />
  </div>;
}

function BoardPage(): JSX.Element {
  const app = useApp();
  const board = createScopedRead<BoardView>({
    scope: app.scope,
    load: (scope, signal) => boardQuery(scope.workspaceId, signal),
    isEmpty: (view) => view.cards.length === 0,
    refreshMs: 15_000,
  });
  const [conflict, setConflict] = createSignal<string>();
  async function move(cardId: string, status: string, version: number, evidenceDigest?: string) {
    try {
      const result = await app.run("board.move", { cardId, status: status as "to-decide" | "todo" | "in-progress" | "verifying" | "done" | "blocked", evidenceDigest }, { expectedVersion: version });
      setConflict(result.accepted ? undefined : `${result.detail} The board shows the newer state; decide again if the intent stands.`);
      await board.refresh({ force: true });
    } catch (e) {
      await board.refresh({ force: true });
      setConflict(e instanceof Error ? e.message : "The move was refused; the board shows the newer state.");
    }
  }
  return <BoardScreen board={board.state().data} state={board.state()} conflict={conflict()}
    onRefresh={() => void board.refresh({ force: true })}
    onCreate={async (title, criteria) => {
      try { const result = await app.run("board.create", { title, criteria }); setConflict(undefined); if (result.accepted) await board.refresh({ force: true }); }
      catch { /* the refresh above surfaces the authoritative state */ }
    }}
    onMove={move}
    onComment={async (cardId, text) => {
      const card = board.state().data?.cards.find((c) => c.cardId === cardId);
      await app.run("board.comment", { cardId, text }, { expectedVersion: card?.version ?? 0 });
      await board.refresh({ force: true });
    }} />;
}

function DecisionsPage(): JSX.Element {
  const app = useApp();
  const decisions = createScopedRead<DecisionHistoryEntry[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await decisionsQuery(scope.workspaceId, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 30_000,
  });
  const board = createScopedRead<BoardView>({
    scope: app.scope,
    load: (scope, signal) => boardQuery(scope.workspaceId, signal),
  });
  return <DecisionsScreen decisions={decisions.state().data ?? []} state={decisions.state()} cardIds={(board.state().data?.cards ?? []).map((c) => c.cardId)}
    viewerId={app.identity()?.actor.actorId} viewerName={app.identity()?.displayName}
    onRefresh={() => void decisions.refresh({ force: true })}
    onRecord={async (cardId, decision, note) => {
      const card = board.state().data?.cards.find((c) => c.cardId === cardId);
      const result = await app.run("decision.record", { cardId, decision, note }, { expectedVersion: card?.version ?? 0 });
      if (result.accepted) await decisions.refresh({ force: true });
    }}
    />;
}

function ApprovalsPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const approvals = createScopedRead<ApprovalRequest[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await approvalsQuery({ workspaceId: scope.workspaceId }, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    // No background poll: a refresh would replace the row objects and destroy
    // an open exact-review dialog mid-decision. Screens refresh explicitly
    // after actions, and the server rechecks authority at decision time.
  });
  return <ApprovalsScreen approvals={approvals.state().data ?? []} state={approvals.state()} asOf={approvals.state().asOf}
    active={app.canApprove()} onRefresh={() => void approvals.refresh({ force: true })}
    onOpen={(approvalId) => void navigate(`/approvals/${approvalId}`)}
    verifyIdentity={app.verifyIdentity} submitDecision={app.submitDecision} checkDecision={app.checkDecision} />;
}

function ApprovalDetailPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const approvalId = () => params.id ?? "";
  const approval = createScopedRead<ApprovalRequest>({
    scope: app.scope,
    load: (_scope, signal) => approvalQuery(approvalId(), signal),
  });
  const history = createScopedRead<{ id: string; action: string; actorId: string; occurredAt: string }[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      if (!scope.workspaceId) return { snapshot: [], asOf: new Date(0).toISOString(), sourceWatermark: 0 };
      const loaded = await auditQuery(scope.workspaceId, signal);
      return {
        ...loaded,
        snapshot: loaded.snapshot.items.filter((entry) => entry.resourceId === params.id)
          .map((entry) => ({ id: entry.id, action: entry.action, actorId: entry.actorId, occurredAt: entry.occurredAt })),
      };
    },
  });
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <ApprovalDetailScreen approval={approval.state().data} state={approval.state()} asOf={approval.state().asOf}
      onRefresh={() => void approval.refresh({ force: true })} onBack={() => void navigate("/approvals")}
      history={history.state().data ?? []}
      onRevoke={async (reason) => {
        try {
          const result = await app.run("approval.revoke", { approvalId: approvalId(), reason });
          setMessage(result.detail);
          await approval.refresh({ force: true });
        } catch (e) { setMessage(e instanceof Error ? e.message : "Revocation failed."); }
      }}
      verifyIdentity={app.verifyIdentity} submitDecision={app.submitDecision} checkDecision={app.checkDecision} />
  </div>;
}

function JobDetailPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const jobId = () => params.id ?? "";
  const job = createScopedRead<JobSnapshot>({
    scope: app.scope,
    load: (scope, signal) => jobQuery(scope.workspaceId, jobId(), signal),
    refreshMs: 10_000,
  });
  const explanation = createScopedRead<PlacementExplanation>({
    scope: app.scope,
    load: (scope, signal) => jobExplainQuery(scope.workspaceId, jobId(), signal),
  });
  const sessions = createScopedRead<SessionView[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await sessionsQuery({ workspaceId: scope.workspaceId }, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
  });
  const [message, setMessage] = createSignal("");
  const jobSession = () => (sessions.state().data ?? []).find((s) => s.jobId === jobId());
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <RunDetail jobId={jobId()} job={job.state().data} explanation={explanation.state().data}
      state={job.state()} onRefresh={() => void job.refresh({ force: true })}
      {...(jobSession() ? { onOpenSession: (sessionId: string) => void navigate(`/sessions/${sessionId}`) } : {})}
      onCancel={async (reason) => {
        const runId = job.state().data?.workflowRunId;
        if (!runId) { setMessage("No run is bound to this job yet."); return; }
        const result = await app.run("workflow.cancel", { runId, reason });
        setMessage(result.detail);
        await job.refresh({ force: true });
      }}
      onReconcile={async (reason) => {
        const current = job.state().data;
        if (!current) return;
        const result = await app.run("job.reconcile", { jobId: jobId(), reason }, { expectedVersion: current.version });
        setMessage(result.detail);
        await job.refresh({ force: true });
      }} />
  </div>;
}

function RunsPage(props: { initialTab?: "runs" | "sessions" | "runners" }): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const runs = createScopedRead<{ jobs: JobSnapshot[]; sessions: SessionView[]; runners: RunnerSnapshot[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const [j, s, r] = await Promise.all([
        jobsQuery({ workspaceId: scope.workspaceId }, signal),
        sessionsQuery({ workspaceId: scope.workspaceId }, signal),
        runnersQuery({ workspaceId: scope.workspaceId }, signal),
      ]);
      return {
        asOf: j.asOf, sourceWatermark: j.sourceWatermark,
        snapshot: { jobs: [...j.snapshot.items], sessions: [...s.snapshot.items], runners: [...r.snapshot.items] },
      };
    },
    isEmpty: (data) => data.jobs.length === 0 && data.sessions.length === 0 && data.runners.length === 0,
    refreshMs: 10_000,
  });
  return <RunsScreen workspaceId={app.workspaceId()} initialTab={props.initialTab}
    jobs={runs.state().data?.jobs ?? []} sessions={runs.state().data?.sessions ?? []} runners={runs.state().data?.runners ?? []}
    state={runs.state()} onRefresh={() => void runs.refresh({ force: true })}
    onOpenJob={(jobId) => void navigate(`/jobs/${jobId}`)}
    onOpenSession={(sessionId) => void navigate(`/sessions/${sessionId}`)}
    onOpenRunner={(runnerId) => void navigate(`/runners/${runnerId}`)}
    onDispatch={() => void navigate(`/w/${app.workspaceId()}/overview`)}
    canDispatch={app.canDispatch()} />;
}

function RunnersPage(): JSX.Element {
  return <RunsPage initialTab="runners" />;
}

function RunnerDetailPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const runnerId = () => params.id ?? "";
  const runner = createScopedRead<RunnerSnapshot>({
    scope: app.scope,
    load: (_scope, signal) => runnerQuery(runnerId(), signal),
    refreshMs: 15_000,
  });
  const [message, setMessage] = createSignal("");
  async function operate(action: "runner.drain" | "runner.quarantine", reason: string) {
    try {
      const result = await app.run(action, { runnerId: runnerId(), reason });
      setMessage(result.detail);
      await runner.refresh({ force: true });
    } catch (e) { setMessage(e instanceof Error ? e.message : "Runner operation failed."); }
  }
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <RunnerDetailScreen runner={runner.state().data} state={runner.state()}
      onRefresh={() => void runner.refresh({ force: true })} onBack={() => void navigate("/runners")}
      onDrain={(reason) => operate("runner.drain", reason)} onQuarantine={(reason) => operate("runner.quarantine", reason)}
      canOperate={app.canOperate()} />
  </div>;
}

function SessionDetailPage(): JSX.Element {
  const app = useApp();
  const params = useParams();
  const sessionId = () => params.id ?? "";
  const session = createScopedRead<SessionView>({
    scope: app.scope,
    load: (scope, signal) => sessionQuery(scope.workspaceId, sessionId(), signal),
    refreshMs: 5_000,
  });
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <SessionFeed sessionId={sessionId()} session={session.state().data} state={session.state()}
      onRefresh={() => void session.refresh({ force: true })}
      onSteer={async (messageText) => {
        try {
          const result = await app.run("session.steer", { sessionId: sessionId(), message: messageText });
          setMessage(result.detail);
        } catch (e) { setMessage(e instanceof Error ? e.message : "Steering was refused."); }
      }}
      onStop={async (reason) => {
        try {
          const result = await app.run("session.stop", { sessionId: sessionId(), reason });
          setMessage(result.detail);
          await session.refresh({ force: true });
        } catch (e) { setMessage(e instanceof Error ? e.message : "Stop was refused."); }
      }} />
  </div>;
}

function monthPeriod(): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { periodStart: periodStart.toISOString(), periodEnd: now.toISOString() };
}

function SupportPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const support = createScopedRead<{ tickets: TicketSummary[]; sla?: SLASummary }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const period = monthPeriod();
      const [tickets, sla] = await Promise.all([
        ticketsQuery(scope.workspaceId, signal),
        slaQuery(scope.workspaceId, period.periodStart, period.periodEnd, signal).catch(() => undefined),
      ]);
      return {
        asOf: tickets.asOf, sourceWatermark: tickets.sourceWatermark,
        snapshot: { tickets: [...tickets.snapshot.items], sla: sla?.snapshot },
      };
    },
    isEmpty: (data) => data.tickets.length === 0,
    refreshMs: 30_000,
  });
  return <SupportScreen tickets={support.state().data?.tickets ?? []} sla={support.state().data?.sla}
    state={support.state()} onRefresh={() => void support.refresh({ force: true })}
    onOpenTicket={(ticketId) => void navigate(`/tickets/${ticketId}`)}
    onDispatch={() => void navigate(`/w/${app.workspaceId()}/overview`)}
    canDispatch={app.canDispatch()} />;
}

function TicketDetailPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const workspaceId = useDetailWorkspace();
  const ticketId = () => params.id ?? "";
  const ticket = createScopedRead<TicketDetail>({
    scope: app.scope,
    load: (_scope, signal) => ticketQuery(workspaceId(), ticketId(), signal),
  });
  return <TicketDetailScreen ticket={ticket.state().data} state={ticket.state()}
    onRefresh={() => void ticket.refresh({ force: true })} onBack={() => void navigate(`/w/${workspaceId()}/support`)}
    onOpenApproval={(approvalId) => void navigate(`/approvals/${approvalId}`)} />;
}

function SrePage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const incidents = createScopedRead<IncidentSummary[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await incidentsQuery(scope.workspaceId, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 15_000,
  });
  return <SreScreen incidents={incidents.state().data ?? []} state={incidents.state()}
    onRefresh={() => void incidents.refresh({ force: true })}
    onOpenIncident={(incidentId) => void navigate(`/incidents/${incidentId}`)}
    onDispatch={() => void navigate(`/w/${app.workspaceId()}/overview`)}
    canDispatch={app.canDispatch()} />;
}

function IncidentDetailPage(): JSX.Element {
  const app = useApp();
  const navigate = useNavigate();
  const params = useParams();
  const workspaceId = useDetailWorkspace();
  const incidentId = () => params.id ?? "";
  const incident = createScopedRead<IncidentDetail>({
    scope: app.scope,
    load: (_scope, signal) => incidentQuery(workspaceId(), incidentId(), signal),
    refreshMs: 30_000,
  });
  return <IncidentDetailScreen incident={incident.state().data} state={incident.state()}
    onRefresh={() => void incident.refresh({ force: true })} onBack={() => void navigate(`/w/${workspaceId()}/sre`)} />;
}

function DeliveryPage(): JSX.Element {
  const app = useApp();
  const dossiers = createScopedRead<DeliveryDossier[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await deliveryQuery(scope.workspaceId, undefined, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 30_000,
  });
  const board = createScopedRead<BoardView>({
    scope: app.scope,
    load: (scope, signal) => boardQuery(scope.workspaceId, signal),
  });
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <DeliveryScreen dossiers={dossiers.state().data ?? []} state={dossiers.state()}
      onRefresh={() => void dossiers.refresh({ force: true })} onOpen={() => undefined}
      onDecide={async (cardId, note) => {
        const card = board.state().data?.cards.find((c) => c.cardId === cardId);
        const result = await app.run("decision.record", { cardId, decision: "go", note }, { expectedVersion: card?.version ?? 0 });
        setMessage(result.detail);
      }} />
  </div>;
}

function KnowledgePage(): JSX.Element {
  const app = useApp();
  const [searchText, setSearchText] = createSignal("");
  const knowledge = createScopedRead<{ results: MemoryResult[]; degraded: boolean; tools: ToolCatalogEntry[] }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const identity = app.identity();
      type MemorySearch = { snapshot: { results: readonly MemoryResult[]; degraded: boolean } };
      const memory: MemorySearch = searchText().trim() && identity
        ? await memorySearchQuery(scope.workspaceId, {
          contractVersion: "brain.memory/v1", queryId: `web-${crypto.randomUUID()}`,
          scope: { organizationId: identity.actor.organizationId, visibility: "workspace", workspaceId: scope.workspaceId },
          query: searchText().trim(), sourceTypes: ["chat", "skill", "wiki", "codegraph"], limit: 10, maxChars: 4000,
        }, signal).catch(() => ({ snapshot: { results: [] as MemoryResult[], degraded: true } }))
        : { snapshot: { results: [], degraded: false } };
      const tools = await toolsQuery(scope.workspaceId, signal);
      return {
        asOf: tools.asOf, sourceWatermark: tools.sourceWatermark,
        snapshot: { results: [...memory.snapshot.results], degraded: memory.snapshot.degraded, tools: [...tools.snapshot.items] },
      };
    },
    isEmpty: (data) => data.results.length === 0,
  });
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <KnowledgeScreen workspaceId={app.workspaceId()} tools={knowledge.state().data?.tools ?? []}
      state={knowledge.state()} searched={searchText().trim().length > 0} onRefresh={() => void knowledge.refresh({ force: true })}
      onSearch={(text) => { setSearchText(text); void knowledge.refresh({ force: true }); }}
      onPublish={async (publication: MemoryPublicationInput) => {
        try {
          const result = await app.run("memory.publish", publication);
          setMessage(result.detail);
          await knowledge.refresh({ force: true });
        } catch (e) { setMessage(e instanceof Error ? e.message : "Publication failed."); }
      }}
      onRevoke={async (sourceId, reason) => {
        try {
          const result = await app.run("memory.revoke", { sourceId, reason });
          setMessage(result.detail);
          await knowledge.refresh({ force: true });
        } catch (e) { setMessage(e instanceof Error ? e.message : "Revocation failed."); }
      }}
      canPublish={app.canPublish()} />
  </div>;
}

function ToolsPage(): JSX.Element {
  const app = useApp();
  const tools = createScopedRead<ToolCatalogEntry[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await toolsQuery(scope.workspaceId, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 60_000,
  });
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <ToolsScreen tools={tools.state().data ?? []} state={tools.state()}
      onRefresh={() => void tools.refresh({ force: true })} canPublish={app.canPublish()}
      onPropose={async (proposal: ToolProposalInput) => {
        try {
          const result = await app.run("tool.propose", proposal);
          setMessage(result.detail);
          await tools.refresh({ force: true });
        } catch (e) { setMessage(e instanceof Error ? e.message : "Proposal failed."); }
      }}
      onPublish={async (release, evidence) => {
        try {
          const result = await app.run("tool.publish", { release, evidence });
          setMessage(result.detail);
          await tools.refresh({ force: true });
        } catch (e) { setMessage(e instanceof Error ? e.message : "Publish failed."); }
      }} />
  </div>;
}

function SettingsPage(): JSX.Element {
  const app = useApp();
  const settings = createScopedRead<{ members: MemberGrantView[]; audit: AuditEntry[]; health?: HealthView }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const [members, audit, health] = await Promise.all([
        membersQuery(scope.workspaceId, signal),
        auditQuery(scope.workspaceId, signal),
        healthQuery(signal).catch(() => undefined),
      ]);
      return {
        asOf: audit.asOf, sourceWatermark: audit.sourceWatermark,
        snapshot: { members: [...members.snapshot.items], audit: [...audit.snapshot.items], health: health?.snapshot },
      };
    },
    isEmpty: (data) => data.members.length === 0 && data.audit.length === 0,
    refreshMs: 30_000,
  });
  const context = createScopedRead<WorkspaceContext>({
    scope: app.scope,
    load: (scope, signal) => workspaceContextQuery(scope.workspaceId, signal),
  });
  const explanation = createScopedRead<ConfigExplanation>({
    scope: app.scope,
    load: (scope, signal) => configExplainQuery(scope.workspaceId, "/workflows", signal),
  });
  const [message, setMessage] = createSignal("");
  return <div class="flex flex-col gap-field-gap">
    <Show when={message()}><p role="status" class="text-base text-ink-gray-7">{message()}</p></Show>
    <SettingsScreen workspaceId={app.workspaceId()}
      members={settings.state().data?.members ?? []} audit={settings.state().data?.audit ?? []}
      health={settings.state().data?.health} explanation={explanation.state().data}
      state={settings.state()} onRefresh={() => void settings.refresh({ force: true })}
      canAdminister={app.canAdminister()}
      onGrant={async (principalId, role, reason) => {
        const result = await app.run("member.grant", { principalId, role: role as "viewer" | "operator" | "workspace-lead" | "approver", reason });
        setMessage(result.detail);
        await settings.refresh({ force: true });
      }}
      onRevoke={async (principalId, role, reason) => {
        const result = await app.run("member.revoke", { principalId, role: role as "viewer" | "operator" | "workspace-lead" | "approver", reason });
        setMessage(result.detail);
        await settings.refresh({ force: true });
      }}
      onActivate={async (configDigest, expectedActiveDigest) => {
        const result = await app.run("config.activate", { configDigest, expectedActiveDigest });
        setMessage(result.detail);
        await Promise.all([settings.refresh({ force: true }), context.refresh({ force: true })]);
      }}
      onStageRelease={async (documents, sourceRevision) => {
        // Releases stage through the setup endpoint, not a command envelope.
        // With no revision given, the staged content itself is the revision.
        const material = documents.map((d) => `${d.path}\n${d.text}`).join("\n");
        const digestBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
        const contentRevision = `sha256:${[...new Uint8Array(digestBuf)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
        await governor(`/v1/setup/config`, { documents, sourceRevision: sourceRevision || contentRevision, activate: true });
        await Promise.all([settings.refresh({ force: true }), context.refresh({ force: true }), explanation.refresh({ force: true })]);
      }}
      activeConfigDigest={context.state().data?.release.configDigest}
      viewerId={app.identity()?.actor.actorId} viewerName={app.identity()?.displayName} />
  </div>;
}
/** Kiosk boards: redacted aggregates, read-only, no app shell. */
function TvBoard(props: { area: "support" | "sre" }): JSX.Element {
  const app = useApp();
  const support = createScopedRead<{ tickets: TicketSummary[]; sla?: SLASummary }>({
    scope: app.scope,
    load: async (scope, signal) => {
      const period = monthPeriod();
      const [tickets, sla] = await Promise.all([
        ticketsQuery(scope.workspaceId, signal),
        slaQuery(scope.workspaceId, period.periodStart, period.periodEnd, signal).catch(() => undefined),
      ]);
      return {
        asOf: tickets.asOf, sourceWatermark: tickets.sourceWatermark,
        snapshot: { tickets: [...tickets.snapshot.items], sla: sla?.snapshot },
      };
    },
    isEmpty: (data) => data.tickets.length === 0,
    refreshMs: 20_000,
  });
  const incidents = createScopedRead<IncidentSummary[]>({
    scope: app.scope,
    load: async (scope, signal) => {
      const loaded = await incidentsQuery(scope.workspaceId, signal);
      return { ...loaded, snapshot: [...loaded.snapshot.items] };
    },
    isEmpty: (items) => items.length === 0,
    refreshMs: 20_000,
  });
  return <main data-testid="tv-kiosk" class="flex flex-col gap-field-gap p-8">
    <header class="flex items-center justify-between">
      <h1 class="text-heading">Keyrus Brain — {props.area === "support" ? "Support" : "SRE"} board</h1>
      <p class="text-caption text-ink-gray-7">Read-only redacted view · auto-refreshing</p>
    </header>
    <Show when={props.area === "support"} fallback={
      <SreScreen incidents={incidents.state().data ?? []} state={incidents.state()}
        onRefresh={() => void incidents.refresh({ force: true })} onOpenIncident={() => undefined}
        onDispatch={() => undefined} canDispatch={false} />
    }>
      <SupportScreen tickets={support.state().data?.tickets ?? []} sla={support.state().data?.sla}
        state={support.state()} onRefresh={() => void support.refresh({ force: true })}
        onOpenTicket={() => undefined} onDispatch={() => undefined} canDispatch={false} />
    </Show>
  </main>;
}

export function TvSupportPage(): JSX.Element { return <TvBoard area="support" />; }
export function TvSrePage(): JSX.Element { return <TvBoard area="sre" />; }

export const pages = {
  TodayPage, BridgePage, WorkspaceOverviewPage, BoardPage, DecisionsPage, RunsPage, RunnersPage,
  ApprovalsPage, ApprovalDetailPage, JobDetailPage, RunnersDetailPage: RunnerDetailPage, SessionDetailPage,
  SupportPage, TicketDetailPage, SrePage, IncidentDetailPage, DeliveryPage, KnowledgePage, ToolsPage, SettingsPage,
  TvSupportPage, TvSrePage,
};
