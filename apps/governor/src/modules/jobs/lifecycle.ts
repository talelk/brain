import { stricterIsolation, type ArtifactRef, type JsonValue, type Placement } from "@brain/contracts";
import type { Store } from "../../application/store";
import { policyForRelease, releaseRecord, type PolicyRefusal } from "../configuration/index";
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
  /** The engine state this job continues (a resumed session): only an engine that can resume it, on the runner holding it, may take the job. */
  resume?: { engineId: string; engineState: ArtifactRef; fromSessionId: string } | undefined;
  /** The priority of the work the run serves, 0 low .. 3 urgent: the claim sorts on it within a workspace (ADR 0041). */
  priority: number;
  /** Set when the release policy refuses the step (ADR 0067): the job is recorded as failed, with the layer and field named, and no runner ever sees it. */
  refusal?: PolicyRefusal | undefined;
}

export type ReconciliationOutcome = "applied" | "absent" | "conflicting" | "unknown";

/** Job states that keep a workspace busy; outcome_unknown is also unresolved. */
const ACTIVE_STATES = ["queued", "offered", "running", "verifying", "blocked", "outcome_unknown"] as const;

/** Narrows the step placement to the engines the pinned agent can run on. */
function agentPlacement(s: Store, input: CreateJobInput): string {
  const step = (input.payload as { step?: { uses?: { type: string; release: { id: string } } } }).step;
  if (step?.uses?.type !== "agent") return input.placementJson;
  const agent = releaseRecord(s, input.organizationId, input.configDigest)?.release.agents?.[step.uses.release.id];
  if (!agent) throw new BrainDomainError("INVALID_CONTRACT", "agent is absent from pinned release");
  const placement = JSON.parse(input.placementJson) as Placement;
  const compatible = placement.engine ? agent.spec.engine.anyOf.filter((id) => placement.engine!.anyOf.includes(id)) : agent.spec.engine.anyOf;
  const anyOf = input.resume ? compatible.filter((id) => id === input.resume!.engineId) : compatible;
  if (!anyOf.length) throw new BrainDomainError("INVALID_CONTRACT", input.resume ? `the agent no longer runs on ${input.resume.engineId}, so its saved state cannot be resumed` : "agent and workflow engine requirements do not intersect");
  const features = [...agent.spec.engine.features, ...(placement.engine?.features ?? []), ...(input.resume ? ["resume"] : [])];
  return JSON.stringify({ ...placement, engine: { anyOf, features: [...new Set(features)] } });
}

/** The step's isolation raised to the release policy's minimum, so a runner or engine that states less is never offered the job (ordered, ADR 0067). */
function withPolicyIsolation(s: Store, input: CreateJobInput, placementJson: string): string {
  const policy = policyForRelease(s, input.organizationId, input.configDigest);
  const placement = JSON.parse(placementJson) as Placement;
  if (!policy || !placement.isolation) return placementJson;
  const isolation = stricterIsolation(placement.isolation, policy.effective.minimumIsolation);
  return isolation === placement.isolation ? placementJson : JSON.stringify({ ...placement, isolation });
}

/** An agent step carries its output schema so the runner can tell the model exactly which violations to fix before the Governor rejects the reply. */
function withOutputSchema(s: Store, input: CreateJobInput): JsonValue {
  const payload = input.payload as { step?: { uses?: { type: string }; outputSchemaRef?: string } } & Record<string, JsonValue>;
  const step = payload.step;
  if (input.kind !== "dispatch" || step?.uses?.type !== "agent" || !step.outputSchemaRef) return input.payload;
  const schema = releaseRecord(s, input.organizationId, input.configDigest)?.release.schemas?.[step.outputSchemaRef];
  return schema ? { ...payload, outputSchema: schema as JsonValue } : input.payload;
}

/** A resumed step's payload names the saved engine state the runner starts from; it travels in the pinned execution artifact like the rest of the job. */
function withResume(input: CreateJobInput, payload: JsonValue): JsonValue {
  if (!input.resume) return payload;
  return { ...(payload as Record<string, JsonValue>), resume: { engineState: input.resume.engineState as unknown as JsonValue, fromSessionId: input.resume.fromSessionId } };
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
    placementJson = withPolicyIsolation(s, input, placementJson);
    // A refused step is still a job, so its run page can say why; it starts failed, and no queue, claim or runner can reach it.
    const state = input.refusal ? "failed" : "queued";
    s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, queue_reason, priority, created_at_ms, ready_at_ms, deadline_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(jobId, input.organizationId, input.workspaceId, input.executionKey, input.runId, input.stepId, state, input.configDigest, placementJson, input.executionDigest, input.effectClass, input.refusal ? "POLICY_REFUSED" : "WAITING_FOR_RUNNER", input.priority, s.now(), s.now(), s.now() + 7 * 24 * 3600_000);
    const payload = withResume(input, withOutputSchema(s, input));
    s.control.prepare("INSERT INTO job_payloads(job_id, kind, payload_json) VALUES (?,?,?)").run(jobId, input.kind, JSON.stringify(input.refusal ? { ...(payload as Record<string, JsonValue>), refusal: { ...input.refusal } } : payload));
    s.emit(s.control, { organizationId: input.organizationId, workspaceId: input.workspaceId, aggregateType: "job", aggregateId: jobId, eventType: input.refusal ? "job.refused" : "job.queued", payload: { jobId, runId: input.runId, stepId: input.stepId, ...(input.refusal ? { layer: input.refusal.layer, field: input.refusal.field } : {}) }, destinations: [`workspace:${input.workspaceId}`] });
    return jobId;
  });
}

/** A person changed the priority of the work a run serves: the run's jobs still waiting for a runner are claimed at the new priority. */
export function reprioritizeQueuedJobs(s: Store, runId: string, jobPriority: number): void {
  s.control.prepare(`UPDATE jobs SET priority=?
    WHERE workflow_run_id=? AND state IN ('queued') AND priority!=?`).run(jobPriority, runId, jobPriority);
}

/** Cancels a run's jobs that no runner holds yet (queued, offered, or parked while a person decides a change it proposed). */
export function cancelJobsForRun(s: Store, runId: string): void {
  s.inTx(s.control, () => {
    for (const job of s.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=? AND state IN ('queued','offered','blocked')").all(runId) as Array<{ id: string }>) {
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
