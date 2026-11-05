import type { Agent, JsonValue, Placement } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { bulkTransition, transitionState } from "../../domain/states";
import { releaseReservation } from "./attempts";

/**
 * Job lifecycle outside the runner protocol: creation for a workflow step,
 * cancellation with its run, reconciliation of an unknown outcome and
 * conclusion by an accepted verdict. With attempts.ts this is the only code
 * that writes jobs and job_attempts. Private file; the public surface is
 * JobProtocol.
 */

export interface CreateJobInput {
  organizationId: string; workspaceId: string; runId: string; stepId: string;
  executionKey: string; configDigest: string; placementJson: string;
  executionDigest: string; effectClass: string; kind: string; payload: JsonValue;
  /** The runner the run was pinned to at dispatch, if any. */
  runnerId?: string | undefined;
}

export type ReconciliationOutcome = "applied" | "absent" | "conflicting" | "unknown";

/** Job states that keep a workspace busy; outcome_unknown is also unresolved. */
const ACTIVE_STATES = ["queued", "offered", "running", "verifying", "blocked", "outcome_unknown"] as const;

/** Narrows the step placement to the engines the pinned agent can run on. */
function agentPlacement(s: Store, input: CreateJobInput): string {
  const step = (input.payload as { step?: { uses?: { type: string; release: { id: string } } } }).step;
  if (step?.uses?.type !== "agent") return input.placementJson;
  const release = s.control.prepare("SELECT manifest_json FROM config_releases WHERE digest=? AND organization_id=?").get(input.configDigest, input.organizationId) as { manifest_json: string };
  const agent = (JSON.parse(release.manifest_json) as { agents: Record<string, Agent> }).agents[step.uses.release.id];
  if (!agent) throw new BrainDomainError("INVALID_CONTRACT", "agent is absent from pinned release");
  const placement = JSON.parse(input.placementJson) as Placement;
  const anyOf = placement.engine ? agent.spec.engine.anyOf.filter((id) => placement.engine!.anyOf.includes(id)) : agent.spec.engine.anyOf;
  if (!anyOf.length) throw new BrainDomainError("INVALID_CONTRACT", "agent and workflow engine requirements do not intersect");
  return JSON.stringify({ ...placement, engine: { anyOf, features: [...new Set([...agent.spec.engine.features, ...(placement.engine?.features ?? [])])] } });
}

/** Queues the job for one step; the execution key makes a repeat return the same job. */
export function createJobForStep(s: Store, input: CreateJobInput): string {
  return s.inTx(s.control, () => {
    s.assertWorkspaceActive(input.workspaceId, input.organizationId);
    const existing = s.control.prepare("SELECT id FROM jobs WHERE organization_id=? AND execution_key=?").get(input.organizationId, input.executionKey) as { id: string } | undefined;
    if (existing) return existing.id;
    const jobId = s.id("job");
    let placementJson = agentPlacement(s, input);
    if (input.runnerId) placementJson = JSON.stringify({ ...(JSON.parse(placementJson) as Placement), runnerId: input.runnerId });
    s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, queue_reason, created_at_ms, ready_at_ms, deadline_ms)
      VALUES (?,?,?,?,?,?,'queued',?,?,?,?,'WAITING_FOR_RUNNER',?,?,?)`)
      .run(jobId, input.organizationId, input.workspaceId, input.executionKey, input.runId, input.stepId, input.configDigest, placementJson, input.executionDigest, input.effectClass, s.now(), s.now(), s.now() + 7 * 24 * 3600_000);
    s.control.prepare("INSERT INTO job_payloads(job_id, kind, payload_json) VALUES (?,?,?)").run(jobId, input.kind, JSON.stringify(input.payload));
    s.emit(s.control, { organizationId: input.organizationId, workspaceId: input.workspaceId, aggregateType: "job", aggregateId: jobId, eventType: "job.queued", payload: { jobId, runId: input.runId, stepId: input.stepId }, destinations: [`workspace:${input.workspaceId}`] });
    return jobId;
  });
}

/** Cancels a run's jobs that no runner holds yet (queued or offered). */
export function cancelJobsForRun(s: Store, runId: string): void {
  s.inTx(s.control, () => {
    for (const job of s.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=? AND state IN ('queued','offered')").all(runId) as Array<{ id: string }>) {
      transitionState(s.control, "job", job.id, "cancelled", { bumpVersion: true });
    }
  });
}

/**
 * Resolves the pending reconciliation of an outcome_unknown job with
 * target-specific evidence. applied → verifying; absent → the unknown
 * attempts fail and the job queues for a fresh attempt; conflicting or
 * unknown → the request blocks and the job stays outcome_unknown.
 */
export function resolveReconciliation(s: Store, input: { organizationId: string; jobId: string; outcome: ReconciliationOutcome; evidenceDigest: string }): { jobId: string; outcome: ReconciliationOutcome } {
  s.inTx(s.control, () => {
    const job = s.control.prepare("SELECT id FROM jobs WHERE id=? AND organization_id=?").get(input.jobId, input.organizationId);
    if (!job) throw new BrainDomainError("NOT_FOUND", "job not found");
    s.control.prepare("UPDATE reconciliation_requests SET state=?, outcome=?, evidence_digest=? WHERE job_id=? AND state IN ('pending','observing')")
      .run(input.outcome === "unknown" || input.outcome === "conflicting" ? "blocked" : "resolved", input.outcome, input.evidenceDigest, input.jobId);
    const unknown = s.control.prepare("SELECT id FROM job_attempts WHERE job_id=? AND state='outcome_unknown'").all(input.jobId) as Array<{ id: string }>;
    if (input.outcome === "applied") {
      for (const a of unknown) transitionState(s.control, "attempt", a.id, "verifying");
      transitionState(s.control, "job", input.jobId, "verifying", { bumpVersion: true });
    } else if (input.outcome === "absent") {
      // The unknown attempt is terminally concluded (effect proven absent)
      // so the one-active-attempt index frees the job for a fresh attempt.
      for (const a of unknown) transitionState(s.control, "attempt", a.id, "failed");
      transitionState(s.control, "job", input.jobId, "queued", { bumpVersion: true });
      for (const a of unknown) releaseReservation(s, a.id);
    } else {
      return;
    }
    s.control.prepare("UPDATE resource_leases SET unresolved_effect=0, expires_at_ms=? WHERE attempt_id IN (SELECT id FROM job_attempts WHERE job_id=?)").run(s.now(), input.jobId);
  });
  return { jobId: input.jobId, outcome: input.outcome };
}

/**
 * Concludes a job and its attempt from an accepted verdict. A job fence makes
 * the transition fail when a newer attempt has taken the job. Runs as a
 * savepoint when the caller holds a control transaction, so it commits with
 * the caller's own records.
 */
export function concludeAttempt(s: Store, input: { jobId: string; attemptId: string; state: "succeeded" | "failed"; jobFence?: number }): void {
  s.inTx(s.control, () => {
    transitionState(s.control, "job", input.jobId, input.state, { bumpVersion: true, ...(input.jobFence === undefined ? {} : { and: { job_fence: input.jobFence } }) });
    transitionState(s.control, "attempt", input.attemptId, input.state);
  });
}

/**
 * Restore quarantine: every attempt that may have started an effect becomes
 * outcome_unknown, and every live job is held (outcome_unknown or blocked
 * pending restore) until independent reconciliation. Runs inside the
 * caller's restore transaction.
 */
export function quarantineJobsForRestore(s: Store): void {
  bulkTransition(s.control, "attempt", "outcome_unknown");
  bulkTransition(s.control, "job", "outcome_unknown", { bumpVersion: true });
  bulkTransition(s.control, "job", "blocked", { set: { queue_reason: "restore_pending" }, bumpVersion: true });
}

/** How much job work a workspace still carries. */
export function workspaceJobLoad(s: Store, workspaceId: string): { unresolved: number; active: number } {
  const row = s.control.prepare(`SELECT COUNT(*) FILTER (WHERE state='outcome_unknown') AS unresolved,
    COUNT(*) FILTER (WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")})) AS active FROM jobs WHERE workspace_id=?`)
    .get(...ACTIVE_STATES, workspaceId) as { unresolved: number; active: number };
  return { unresolved: row.unresolved, active: row.active };
}
