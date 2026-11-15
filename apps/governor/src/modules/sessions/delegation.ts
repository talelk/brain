import type { HandoffFacts, HandoffNotes, JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { releaseRecord } from "../configuration/index";
import { submitDelegatedHandoff } from "../evidence/index";
import { agentPrincipalId } from "../identity/index";
import { enqueueSessionControl } from "./controls";

type Db = ReturnType<Store["workspaceDb"]>;

/** How deep a delegation chain may go (ADR 0051): a task's own session is depth 0, its child 1, and a child of a child of a child 3. */
export const MAX_DELEGATION_DEPTH = 3;
/** How many children one session may have working at once (ADR 0003). An agent's own `maxChildren` can only lower it. */
export const MAX_ACTIVE_CHILDREN = 4;

/** What a pinned agent declares about itself, as delegation reads it. */
export interface PinnedAgent {
  readonly id: string;
  readonly maxChildren: number;
  readonly maxDepth: number;
  readonly maxTokens: number;
  readonly maxMicroUsd: number;
  readonly maxTurns: number;
  readonly tools: readonly string[];
}

/** The agent an attempt's job is pinned to in its release, when the job runs one; absent for a step with no agent and for a job the release no longer has. */
export function pinnedAgentOfJob(store: Store, organizationId: string, jobId: string): PinnedAgent | undefined {
  const row = store.control.prepare("SELECT j.config_digest AS digest, p.payload_json AS payload FROM jobs j JOIN job_payloads p ON p.job_id=j.id WHERE j.id=? AND j.organization_id=?").get(jobId, organizationId) as { digest: string; payload: string } | undefined;
  if (!row) return undefined;
  let id: string | undefined;
  try {
    const uses = (JSON.parse(row.payload) as { step?: { uses?: { type?: string; release?: { id?: string } } } }).step?.uses;
    if (uses?.type === "agent") id = uses.release?.id;
  } catch { return undefined; }
  const agent = id ? releaseRecord(store, organizationId, row.digest)?.release.agents?.[id] : undefined;
  if (!id || !agent) return undefined;
  const spec = agent.spec;
  return { id, maxChildren: spec.maxChildren, maxDepth: spec.maxDepth, maxTokens: spec.maxTokens, maxMicroUsd: spec.maxMicroUsd, maxTurns: spec.maxTurns, tools: spec.tools.map((tool) => tool.id) };
}

/** A delegation whose child run has not started: the pump starts it after the command commits, and again after a restart. */
export interface PendingDelegation {
  readonly delegationId: string;
  readonly missionId: string;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly workItemId: string;
  readonly memberId: string | null;
  readonly delegatingPrincipal: string;
  readonly situation: string;
}

export function pendingDelegations(db: Db): PendingDelegation[] {
  return (db.prepare(`SELECT r.delegation_id AS delegationId, r.mission_id AS missionId, d.parent_session_id AS parentSessionId, d.child_session_id AS childSessionId,
      d.work_item_id AS workItemId, r.member_id AS memberId, r.delegating_principal AS delegatingPrincipal, r.situation AS situation
    FROM delegation_runs r JOIN delegations d ON d.id=r.delegation_id WHERE r.state='pending' AND r.run_id IS NULL ORDER BY r.created_at_ms, r.delegation_id`).all() as PendingDelegation[]);
}

/** The child's run exists: the run is the child session's, which now waits for a runner like any other work. */
export function delegationStarted(store: Store, db: Db, input: { delegationId: string; runId: string }): void {
  store.inTx(db, () => {
    const row = db.prepare("SELECT d.child_session_id AS child FROM delegation_runs r JOIN delegations d ON d.id=r.delegation_id WHERE r.delegation_id=? AND r.state='pending'").get(input.delegationId) as { child: string } | undefined;
    if (!row) return;
    db.prepare("UPDATE delegation_runs SET run_id=?, state='running' WHERE delegation_id=?").run(input.runId, input.delegationId);
    db.prepare("UPDATE sessions SET state='starting',version=version+1,updated_at_ms=? WHERE id=? AND state='waiting'").run(store.now(), row.child);
  });
}

interface RunRow { delegation_id: string; mission_id: string; member_id: string | null; state: string; run_id: string | null }
interface DelegationFacts { id: string; parent: string; child: string; workItemId: string; childJob: string | null }

function factsOf(db: Db, delegationId: string): DelegationFacts | undefined {
  const row = db.prepare("SELECT d.id AS id, d.parent_session_id AS parent, d.child_session_id AS child, d.work_item_id AS workItemId, s.job_id AS childJob FROM delegations d JOIN sessions s ON s.id=d.child_session_id WHERE d.id=?").get(delegationId) as DelegationFacts | undefined;
  return row;
}

/** The parent session hears of its child's end now when it is live and takes steering; otherwise it reads it from its context at its next session. */
function tellParent(store: Store, organizationId: string, workspaceId: string, db: Db, parentSessionId: string, text: string): void {
  const parent = db.prepare("SELECT state, engine_features FROM sessions WHERE id=?").get(parentSessionId) as { state: string; engine_features: string } | undefined;
  if (!parent || parent.state !== "running") return;
  let features: string[] = [];
  try { features = JSON.parse(parent.engine_features) as string[]; } catch { /* no features known */ }
  if (!features.includes("steer")) return;
  try { enqueueSessionControl(store, { organizationId, workspaceId, sessionId: parentSessionId, kind: "session.steer", payload: { sessionId: parentSessionId, message: text } }); } catch (error) { if (!(error instanceof BrainDomainError)) throw error; }
}

/** The child could not run (no way of working to run it, the mission was closed, its parent failed) or its run failed: the failure is recorded and the parent is told. */
export function delegationFailed(store: Store, organizationId: string, workspaceId: string, delegationId: string, reason: string): void {
  const db = store.workspaceDb(workspaceId, organizationId);
  const facts = factsOf(db, delegationId);
  if (!facts) return;
  const failure = reason.replace(/\s+/gu, " ").trim().slice(0, 1000);
  const changed = store.inTx(db, () => {
    const moved = db.prepare("UPDATE delegation_runs SET state='failed', failure_reason=?, finished_at_ms=? WHERE delegation_id=? AND state IN ('pending','running')").run(failure, store.now(), delegationId);
    if (moved.changes !== 1) return false;
    db.prepare("UPDATE sessions SET state='failed',version=version+1,updated_at_ms=? WHERE id=? AND state NOT IN ('stopped','failed')").run(store.now(), facts.child);
    store.emit(db, { aggregateType: "delegation", aggregateId: delegationId, eventType: "delegation.failed", payload: { delegationId, parentSessionId: facts.parent, childSessionId: facts.child, workItemId: facts.workItemId, reason: failure } });
    return true;
  });
  if (changed) tellParent(store, organizationId, workspaceId, db, facts.parent, `Delegated work failed (delegation ${delegationId}): ${failure}. It did not return a result.`);
}

/** Why a child's run failed, in words: the failed attempt's own reason, a failed step's error, or the run's diagnostic. */
function failureOf(store: Store, db: Db, runId: string, diagnostic: string): string {
  const attempt = store.control.prepare("SELECT a.failure_reason AS reason FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.workflow_run_id=? AND a.failure_reason IS NOT NULL ORDER BY a.attempt_no DESC LIMIT 1").get(runId) as { reason: string } | undefined;
  if (attempt?.reason) return `${diagnostic}: ${attempt.reason}`;
  for (const row of db.prepare("SELECT o.output_json FROM step_outputs o JOIN workflow_steps s ON s.run_id=o.run_id AND s.step_id=o.step_id WHERE o.run_id=? AND s.state='failed'").all(runId) as Array<{ output_json: string }>) {
    try {
      const error = (JSON.parse(row.output_json) as { error?: unknown }).error;
      if (typeof error === "string" && error) return `${diagnostic}: ${error}`;
    } catch { /* an output that is not JSON names no error */ }
  }
  return diagnostic;
}

const RESULT_CHARS = 3500;

/** The written result of the child's own step: its summary and the start of its deliverable, bounded; undefined when the step wrote neither. */
function resultOf(store: Store, db: Db, runId: string, childJob: string | null): { summary: string; deliverable?: string } | undefined {
  const step = childJob ? (store.control.prepare("SELECT step_id FROM jobs WHERE id=?").get(childJob) as { step_id: string } | undefined)?.step_id : undefined;
  const rows = db.prepare(`SELECT o.step_id AS step, o.output_json AS json FROM step_outputs o JOIN workflow_steps s ON s.run_id=o.run_id AND s.step_id=o.step_id WHERE o.run_id=? AND s.state='succeeded' ORDER BY o.rowid`).all(runId) as Array<{ step: string; json: string }>;
  const ordered = [...rows.filter((row) => row.step === step), ...rows.filter((row) => row.step !== step)];
  for (const row of ordered) {
    try {
      const parsed = JSON.parse(row.json) as { summary?: unknown; deliverable?: unknown };
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      const deliverable = typeof parsed.deliverable === "string" ? parsed.deliverable.trim() : "";
      if (summary || deliverable) return { summary: summary || deliverable.slice(0, 300), ...(deliverable ? { deliverable } : {}) };
    } catch { /* not a written result */ }
  }
  return undefined;
}

/**
 * A delegated child's run ended (the engine calls this for every run; any other run is none of its business). A finished run hands its
 * result back to the parent's task as a handoff that is the child's own claim (ADR 0051); a failed one becomes a failure fact on the
 * delegation. Idempotent: a delegation that already ended is left as it is.
 */
export function delegatedRunEnded(store: Store, organizationId: string, workspaceId: string, runId: string, outcome: { ok: true } | { ok: false; diagnostic: string }): void {
  const db = store.workspaceDb(workspaceId, organizationId);
  const row = db.prepare("SELECT delegation_id, mission_id, member_id, state, run_id FROM delegation_runs WHERE run_id=?").get(runId) as RunRow | undefined;
  if (!row || row.state !== "running") return;
  if (!outcome.ok) { delegationFailed(store, organizationId, workspaceId, row.delegation_id, failureOf(store, db, runId, outcome.diagnostic)); return; }
  const facts = factsOf(db, row.delegation_id);
  if (!facts) return;
  const result = resultOf(store, db, runId, facts.childJob);
  const bundle = facts.childJob ? db.prepare("SELECT digest FROM evidence_bundles WHERE job_id=? ORDER BY created_at_ms DESC, digest LIMIT 1").get(facts.childJob) as { digest: string } | undefined : undefined;
  const notes: HandoffNotes = {
    summary: [result?.summary ?? "The delegated session finished without writing a result.", ...(result?.deliverable && result.deliverable !== result.summary ? [result.deliverable.slice(0, RESULT_CHARS)] : [])].join("\n\n"),
    nextAction: "Review this result before building on it: it is the child session's claim until a reviewer accepts it.",
  };
  const handoffFacts: HandoffFacts | undefined = bundle ? { evidenceDigest: bundle.digest, criteria: [], outputVersions: [] } : undefined;
  const handoffId = store.inTx(db, () => {
    const moved = db.prepare("UPDATE delegation_runs SET state='succeeded', finished_at_ms=? WHERE delegation_id=? AND state='running'").run(store.now(), row.delegation_id);
    if (moved.changes !== 1) return undefined;
    const id = submitDelegatedHandoff(store, db, { workItemId: facts.workItemId, delegationId: row.delegation_id, submittedBy: agentPrincipalId(row.mission_id, row.member_id), notes, ...(handoffFacts ? { facts: handoffFacts } : {}) });
    db.prepare("UPDATE delegation_runs SET result_handoff_id=? WHERE delegation_id=?").run(id, row.delegation_id);
    store.emit(db, { aggregateType: "delegation", aggregateId: row.delegation_id, eventType: "delegation.completed", payload: { delegationId: row.delegation_id, parentSessionId: facts.parent, childSessionId: facts.child, workItemId: facts.workItemId, handoffId: id } as unknown as JsonValue });
    return id;
  });
  if (handoffId) tellParent(store, organizationId, workspaceId, db, facts.parent, `Delegated work finished (delegation ${row.delegation_id}): ${notes.summary.slice(0, 600)}`);
}

/** The delegation run a run id belongs to, when the run is a delegated child's: the mission and parent task it works for and the member it acts as. */
export function delegatedRunOf(db: Db, runId: string): { delegationId: string; missionId: string; memberId: string | null; workItemId: string; childSessionId: string; situation: string } | undefined {
  return db.prepare(`SELECT r.delegation_id AS delegationId, r.mission_id AS missionId, r.member_id AS memberId, d.work_item_id AS workItemId, d.child_session_id AS childSessionId, r.situation AS situation
    FROM delegation_runs r JOIN delegations d ON d.id=r.delegation_id WHERE r.run_id=?`).get(runId) as ReturnType<typeof delegatedRunOf>;
}
