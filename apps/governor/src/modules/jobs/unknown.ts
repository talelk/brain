import type { JsonValue } from "@brain/contracts";
import type { Store } from "../../application/store";
import { BrainDomainError } from "../../domain/errors";
import { assertExpectedVersion, transitionState } from "../../domain/states";
import { isReadOnlyReasoningJob, releaseReservation } from "./attempts";

/**
 * Steps left "outcome unknown" that a person has to settle (Needs you). Read-only agent and evaluator steps are
 * restarted by the Governor itself and never appear here. A step that is an effectful tool call, or that held an
 * effect permit or lease, may already have changed something outside Brain: it is never retried automatically.
 */
export interface UnknownJobView {
  jobId: string; version: number; organizationId: string; workspaceId: string; runId: string; stepId: string;
  /** True when a second run is harmless: a read step that never held an effect permit or resource lease. */
  idempotent: boolean;
  /** When the step was last heard from (ms). */
  since: number;
  /** The plain reason a person reads. */
  reason: string;
}

function hasEffects(s: Store, jobId: string): boolean {
  const n = s.control.prepare(`SELECT (SELECT COUNT(*) FROM effect_permits p JOIN job_attempts a ON a.id=p.attempt_id WHERE a.job_id=?)
    + (SELECT COUNT(*) FROM resource_leases l JOIN job_attempts a ON a.id=l.attempt_id WHERE a.job_id=?) AS n`).get(jobId, jobId) as { n: number };
  return n.n > 0;
}

interface Row { id: string; version: number; organization_id: string; workspace_id: string; workflow_run_id: string; step_id: string; effect_class: string; job_fence: number; last_ms: number }

function describe(s: Store, row: Row): UnknownJobView | undefined {
  const attempt = s.control.prepare("SELECT id FROM job_attempts WHERE job_id=? AND job_fence=? ORDER BY attempt_no DESC LIMIT 1").get(row.id, row.job_fence) as { id: string } | undefined;
  // The Governor settles these by itself (restart, cooldown retry, then a plain failure that parks the task).
  if (attempt && isReadOnlyReasoningJob(s, row.id, attempt.id)) return undefined;
  const idempotent = row.effect_class === "read" && !hasEffects(s, row.id);
  const reason = idempotent
    ? "Brain lost contact with this step before it reported back. It only reads, so it is safe to try again."
    : "Brain lost contact with this step before it reported back, and it may already have changed something outside Brain. It was not retried automatically, so check the target system first.";
  return { jobId: row.id, version: row.version, organizationId: row.organization_id, workspaceId: row.workspace_id, runId: row.workflow_run_id, stepId: row.step_id, idempotent, since: row.last_ms, reason };
}

export function unknownJobsForWorkspace(s: Store, organizationId: string, workspaceId: string): UnknownJobView[] {
  const rows = s.control.prepare(`SELECT id, version, organization_id, workspace_id, workflow_run_id, step_id, effect_class, job_fence,
      COALESCE((SELECT MAX(MAX(COALESCE(a.lease_expires_at_ms,0), COALESCE(a.offer_expires_at_ms,0))) FROM job_attempts a WHERE a.job_id=jobs.id), ready_at_ms) AS last_ms
    FROM jobs WHERE organization_id=? AND workspace_id=? AND state='outcome_unknown' ORDER BY created_at_ms, id LIMIT 200`).all(organizationId, workspaceId) as unknown as Row[];
  return rows.flatMap((row) => describe(s, row) ?? []);
}

export type UnknownResolution = "fail" | "retry";

/**
 * A person settles a step left outcome unknown. "fail" concludes the attempt and the step as failed (the task parks for a person, as with
 * any failed step); "retry" queues the step again and is refused unless a second run is harmless. Neither claims to know what happened outside.
 */
export function resolveUnknownJob(s: Store, deps: { completeStep: (organizationId: string, workspaceId: string, runId: string, stepId: string, output: JsonValue, ok: boolean) => void },
  input: { organizationId: string; jobId: string; resolution: UnknownResolution; expectedVersion?: number }): { jobId: string; resolution: UnknownResolution } {
  let failure: { view: UnknownJobView; message: string } | undefined;
  s.inTx(s.control, () => {
    const row = s.control.prepare(`SELECT id, version, organization_id, workspace_id, workflow_run_id, step_id, effect_class, job_fence, state, ready_at_ms AS last_ms FROM jobs WHERE id=? AND organization_id=?`).get(input.jobId, input.organizationId) as (Row & { state: string }) | undefined;
    if (!row) throw new BrainDomainError("NOT_FOUND", "job not found");
    if (row.state !== "outcome_unknown") throw new BrainDomainError("CONFLICT", "this step is no longer waiting on you");
    assertExpectedVersion(row.version, input.expectedVersion);
    const view = describe(s, row);
    if (!view) throw new BrainDomainError("CONFLICT", "Brain settles this step by itself");
    if (input.resolution === "retry" && !view.idempotent) throw new BrainDomainError("CONFLICT", "this step may have changed something outside Brain, so repeating it is not safe; treat it as failed instead");
    const unknown = s.control.prepare("SELECT id FROM job_attempts WHERE job_id=? AND state='outcome_unknown'").all(row.id) as Array<{ id: string }>;
    for (const a of unknown) transitionState(s.control, "attempt", a.id, "failed");
    transitionState(s.control, "job", row.id, input.resolution === "retry" ? "queued" : "failed", { ...(input.resolution === "retry" ? { set: { queue_reason: "RETRIED_BY_PERSON" } } : {}), bumpVersion: true });
    for (const a of unknown) releaseReservation(s, a.id);
    // An observation still pending for this job must not later move a step a person has settled.
    s.control.prepare("UPDATE reconciliation_requests SET state='blocked', outcome='unknown' WHERE job_id=? AND state IN ('pending','observing')").run(row.id);
    s.control.prepare("UPDATE resource_leases SET unresolved_effect=0, expires_at_ms=? WHERE attempt_id IN (SELECT id FROM job_attempts WHERE job_id=?)").run(s.now(), row.id);
    if (input.resolution === "fail") failure = { view, message: "This step was cut off before it reported back and may have changed something outside Brain. A person treated it as failed; check the target system before trying again." };
  });
  if (failure) deps.completeStep(failure.view.organizationId, failure.view.workspaceId, failure.view.runId, failure.view.stepId, { error: failure.message, code: "AGENT_INTERRUPTED" } as unknown as JsonValue, false);
  return { jobId: input.jobId, resolution: input.resolution };
}
