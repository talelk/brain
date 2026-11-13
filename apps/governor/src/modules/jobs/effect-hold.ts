import type { ActionSubject, ArtifactRef, JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { domainDigest } from "@brain/contracts";
import { transitionState } from "../../domain/states";
import { readVerified } from "../artifacts/index";

/**
 * Held effect calls (ADR 0028). An agent that proposes a change does not wait for it: its attempt ends and its job is parked, blocked, with
 * the reason below. Each proposal is held as an "act" job (blocked as well) bound to its approval. A decision releases or cancels the act
 * job; once every call a job proposed is settled the job is queued again and its next attempt is told what became of each change.
 *
 * Everything here is derived from rows (the call, its approval, its act job, its permit) and applied in small transactions, so a Governor
 * restart in the middle only means the next pass finishes the work. Nothing here runs a change: the act job's own runner attempt does.
 */

export const HOLD_REASON = "AWAITING_APPROVAL";

interface CallRow {
  attempt_id: string; proposal_id: string; organization_id: string; workspace_id: string; approval_id: string; tool_id: string; input_digest: string;
  created_at_ms: number; parent_job_id: string; act_job_id: string; outcome: string | null; settled_at_ms: number | null;
}
interface JobRow { id: string; state: string; queue_reason: string | null; organization_id: string; workspace_id: string; workflow_run_id: string; step_id: string }

const FINISHED = ["succeeded", "failed", "cancelled", "partial"];
const jobRow = (s: Store, id: string): JobRow | undefined => s.control.prepare("SELECT id, state, queue_reason, organization_id, workspace_id, workflow_run_id, step_id FROM jobs WHERE id=?").get(id) as JobRow | undefined;

/** What became of one proposed change, as the resumed attempt and the evidence bundle need it. */
export interface EffectOutcomeView {
  readonly proposalId: string;
  readonly toolId: string;
  readonly summary: string;
  readonly approvalId: string;
  /** applied, absent, unknown, declined, expired, revoked or cancelled. */
  readonly outcome: string;
  /** What the change reported, for a change that was made. */
  readonly result?: string;
  readonly invocationId?: string;
  readonly targetId?: string;
  readonly operation?: string;
  readonly receiptArtifact?: ArtifactRef;
}

/**
 * What a made change reported (already shaped and redacted by its pinned tool script): a ticket id, a pull request address, the status
 * the launcher gave. Bounded text, for the task that proposed it to quote; nothing here is a secret.
 */
export function effectResultFor(s: Store, approvalId: string): string | undefined {
  const permit = s.control.prepare("SELECT receipt_digest FROM effect_permits WHERE invocation_id=?").get(`inv-${approvalId}`) as { receipt_digest: string | null } | undefined;
  if (!permit?.receipt_digest || !/^sha256:[0-9a-f]{64}$/u.test(permit.receipt_digest)) return undefined;
  try { return new TextDecoder().decode(readVerified(s, permit.receipt_digest)).slice(0, 1500); } catch { return undefined; }
}

/** The settled calls of a job, oldest first. Empty for a job that never proposed a change. */
export function effectOutcomesFor(s: Store, jobId: string): EffectOutcomeView[] {
  const calls = s.control.prepare("SELECT * FROM effect_calls WHERE parent_job_id=? AND settled_at_ms IS NOT NULL ORDER BY created_at_ms, proposal_id").all(jobId) as CallRow[];
  return calls.map((call) => {
    const approval = s.control.prepare("SELECT subject_json FROM approval_requests WHERE id=?").get(call.approval_id) as { subject_json: string };
    const summary = (JSON.parse(approval.subject_json) as ActionSubject).effectBounds["summary"];
    const invocationId = `inv-${call.approval_id}`;
    const result = call.outcome === "applied" ? effectResultFor(s, call.approval_id) : undefined;
    const base = { proposalId: call.proposal_id, toolId: call.tool_id, summary: typeof summary === "string" ? summary : "", approvalId: call.approval_id, outcome: call.outcome ?? "cancelled", ...(result ? { result } : {}) };
    const permit = s.control.prepare("SELECT receipt_digest FROM effect_permits WHERE invocation_id=?").get(invocationId) as { receipt_digest: string | null } | undefined;
    if (!permit?.receipt_digest || !/^sha256:[0-9a-f]{64}$/u.test(permit.receipt_digest)) return base;
    const artifact = s.workspaceDb(call.workspace_id, call.organization_id).prepare("SELECT id, digest, bytes, media_type, classification FROM artifacts WHERE digest=? AND state='verified' ORDER BY created_at_ms LIMIT 1")
      .get(permit.receipt_digest) as { id: string; digest: string; bytes: number; media_type: string; classification: string } | undefined;
    if (!artifact) return base;
    return { ...base, invocationId, targetId: `tool:${call.tool_id}`, operation: `effect.${call.tool_id}`.slice(0, 64), receiptArtifact: { artifactId: artifact.id, digest: artifact.digest, bytes: artifact.bytes, mediaType: artifact.media_type, classification: artifact.classification } as unknown as ArtifactRef };
  });
}

/** The id of the execution artifact the next offer of this job pins: the first one, or one per set of settled changes after a resume. */
export function executionArtifactId(s: Store, jobId: string): string {
  const n = (s.control.prepare("SELECT COUNT(*) AS n FROM effect_calls WHERE parent_job_id=? AND settled_at_ms IS NOT NULL").get(jobId) as { n: number }).n;
  return n === 0 ? `exec-${jobId}` : `exec-${jobId}-e${n}`;
}

/** What a finished act job did, from its permit: the change is applied, certainly not made, or unknown (it may have been). */
function outcomeOfAct(s: Store, call: CallRow, act: JobRow): string {
  if (act.state === "outcome_unknown") return "unknown";
  const permit = s.control.prepare("SELECT state FROM effect_permits WHERE invocation_id=?").get(`inv-${call.approval_id}`) as { state: string } | undefined;
  if (permit?.state === "applied" || permit?.state === "absent") return permit.state;
  if (permit && permit.state !== "issued" && permit.state !== "revoked") return "unknown";
  return "absent";
}

/** Settles one call if its approval was decided or the proposing job is gone. Returns true when something changed. Runs inside a transaction. */
function settleCall(s: Store, attemptId: string, proposalId: string): boolean {
  const call = s.control.prepare("SELECT * FROM effect_calls WHERE attempt_id=? AND proposal_id=?").get(attemptId, proposalId) as CallRow | undefined;
  if (!call || call.settled_at_ms !== null) return false;
  const settle = (outcome: string): boolean => { s.control.prepare("UPDATE effect_calls SET outcome=?, settled_at_ms=? WHERE attempt_id=? AND proposal_id=? AND settled_at_ms IS NULL").run(outcome, s.now(), attemptId, proposalId); return true; };
  const approval = s.control.prepare("SELECT state, expires_at_ms FROM approval_requests WHERE id=?").get(call.approval_id) as { state: string; expires_at_ms: number };
  let state = approval.state;
  if (state === "pending" && approval.expires_at_ms <= s.now()) { transitionState(s.control, "approval", call.approval_id, "expired", { bumpVersion: true }); state = "expired"; }
  const parent = jobRow(s, call.parent_job_id);
  const act = jobRow(s, call.act_job_id);
  const cancelAct = (): void => { if (act && (act.state === "blocked" || act.state === "queued")) transitionState(s.control, "job", act.id, "cancelled", { bumpVersion: true }); };
  // The proposing job is gone (the task was cancelled or failed): nothing waits for this change any more, so it must never run.
  if (!parent || FINISHED.includes(parent.state)) {
    if (state === "pending") transitionState(s.control, "approval", call.approval_id, "revoked", { bumpVersion: true });
    cancelAct();
    return settle("cancelled");
  }
  if (state === "rejected" || state === "expired" || state === "revoked") { cancelAct(); return settle(state === "rejected" ? "declined" : state); }
  if (state !== "approved" || !act) return false;
  if (act.state === "blocked" && act.queue_reason === HOLD_REASON) {
    // Approved: the held job may now be claimed by a runner. Its deadline starts here, not when it was proposed.
    transitionState(s.control, "job", act.id, "queued", { set: { queue_reason: "WAITING_FOR_RUNNER", ready_at_ms: s.now(), deadline_ms: s.now() + 2 * 3600_000 }, bumpVersion: true });
    return true;
  }
  if (act.state === "outcome_unknown" || FINISHED.includes(act.state)) return settle(outcomeOfAct(s, call, act));
  return false;
}

/**
 * One pass over every unsettled call and every parked job. Idempotent and cheap (the open calls are a partial index). Returns how many
 * calls or jobs moved. A job whose change is of unknown outcome is failed with a plain reason through `completeStep`, never retried.
 */
export function settleEffects(s: Store, deps: { completeStep: (organizationId: string, workspaceId: string, runId: string, stepId: string, output: JsonValue, ok: boolean) => void }): number {
  let moved = 0;
  for (const call of s.control.prepare("SELECT attempt_id, proposal_id FROM effect_calls WHERE settled_at_ms IS NULL ORDER BY created_at_ms LIMIT 200").all() as Array<{ attempt_id: string; proposal_id: string }>) {
    if (s.inTx(s.control, () => settleCall(s, call.attempt_id, call.proposal_id))) moved++;
  }
  const parked = s.control.prepare(`SELECT j.id FROM jobs j WHERE j.state='blocked' AND j.queue_reason=?
    AND EXISTS (SELECT 1 FROM effect_calls c WHERE c.parent_job_id=j.id)
    AND NOT EXISTS (SELECT 1 FROM effect_calls c WHERE c.parent_job_id=j.id AND c.settled_at_ms IS NULL) LIMIT 100`).all(HOLD_REASON) as Array<{ id: string }>;
  for (const { id } of parked) {
    let failed: JobRow | undefined;
    const done = s.inTx(s.control, () => {
      const job = jobRow(s, id);
      if (!job || job.state !== "blocked" || job.queue_reason !== HOLD_REASON) return false;
      if ((s.control.prepare("SELECT COUNT(*) AS n FROM effect_calls WHERE parent_job_id=? AND outcome='unknown'").get(id) as { n: number }).n > 0) {
        transitionState(s.control, "job", id, "cancelled", { bumpVersion: true });
        failed = job;
        return true;
      }
      transitionState(s.control, "job", id, "queued", { set: { queue_reason: "WAITING_FOR_RUNNER", ready_at_ms: s.now(), deadline_ms: s.now() + 7 * 24 * 3600_000 }, bumpVersion: true });
      return true;
    });
    if (done) moved++;
    if (failed) deps.completeStep(failed.organization_id, failed.workspace_id, failed.workflow_run_id, failed.step_id, { error: "A change this task asked for may or may not have been made: its outcome is not known. Brain did not retry it and cannot check the result. Look at the target by hand, then start the task again.", code: "EFFECT_OUTCOME_UNKNOWN" } as unknown as JsonValue, false);
  }
  return moved;
}

/**
 * Creates the held act job of a proposal (ADR 0028): blocked, so no runner can claim it, with the proposing job's placement (a host change
 * stays in the host group) and the call itself as its payload. Runs inside the caller's transaction.
 */
export function createActJob(s: Store, input: { id: string; organizationId: string; workspaceId: string; approvalId: string; parentJobId: string; configDigest: string; effectClass: string; approvalExpiresAtMs: number; payload: { [key: string]: JsonValue } }): void {
  const parent = s.control.prepare("SELECT placement_json FROM jobs WHERE id=?").get(input.parentJobId) as { placement_json: string };
  s.control.prepare(`INSERT INTO jobs(id, organization_id, workspace_id, execution_key, workflow_run_id, step_id, state, config_digest, placement_json, execution_digest, effect_class, queue_reason, created_at_ms, ready_at_ms, deadline_ms)
    VALUES (?,?,?,?,?,?,'blocked',?,?,?,?,?,?,?,?)`)
    .run(input.id, input.organizationId, input.workspaceId, `act:${input.approvalId}`, `act-${input.approvalId}`, "act", input.configDigest, parent.placement_json, domainDigest("brain:act-job:v1", input.payload), input.effectClass, HOLD_REASON, s.now(), s.now(), input.approvalExpiresAtMs + 24 * 3600_000);
  s.control.prepare("INSERT INTO job_payloads(job_id, kind, payload_json) VALUES (?,?,?)").run(input.id, "act", JSON.stringify(input.payload));
}
