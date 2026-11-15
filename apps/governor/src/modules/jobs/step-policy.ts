import type { RetryPolicy } from "@brain/contracts";
import type { Store } from "../../application/store";
import { quotaLike } from "../../domain/failure";
import { transitionState } from "../../domain/states";

/**
 * What a step declares about running as a job (ADR 0046): `timeoutSeconds` ends one attempt, `retry` offers the step again as a new
 * attempt of the same job. Private file of the jobs module; attempts.ts applies it where an attempt starts and where it fails.
 */

export interface StepPolicy {
  readonly retry: RetryPolicy | undefined;
  readonly timeoutSeconds: number | undefined;
  readonly effectClass: string;
}

/** The policy the job's step declared, read from the payload pinned when the job was created. A held change (act job) declares none. */
export function stepPolicy(s: Store, jobId: string): StepPolicy {
  const row = s.control.prepare("SELECT j.effect_class AS effectClass, p.payload_json AS payload FROM jobs j LEFT JOIN job_payloads p ON p.job_id=j.id WHERE j.id=?").get(jobId) as { effectClass: string; payload: string | null } | undefined;
  const step = row?.payload ? (JSON.parse(row.payload) as { step?: { retry?: RetryPolicy; timeoutSeconds?: number } }).step : undefined;
  return { retry: step?.retry, timeoutSeconds: step?.timeoutSeconds, effectClass: row?.effectClass ?? "read" };
}

/** Whether the attempt took an effect permit or a resource lease: after that, the world may already have changed. */
export function heldEffect(s: Store, attemptId: string): boolean {
  const row = s.control.prepare("SELECT (SELECT COUNT(*) FROM effect_permits WHERE attempt_id=?) + (SELECT COUNT(*) FROM resource_leases WHERE attempt_id=?) AS n").get(attemptId, attemptId) as { n: number };
  return row.n > 0;
}

/** Sets the attempt's deadline when it starts running, from the step's `timeoutSeconds`; a step declaring none has no deadline. */
export function stampAttemptDeadline(s: Store, jobId: string, attemptId: string): void {
  const { timeoutSeconds } = stepPolicy(s, jobId);
  if (timeoutSeconds !== undefined) s.control.prepare("UPDATE job_attempts SET deadline_ms=? WHERE id=?").run(s.now() + timeoutSeconds * 1000, attemptId);
}

/**
 * An attempt of the job failed on its own account. Counts it, then offers the step again when its `retry` allows: the job goes back
 * to the queue (so the claim applies the mission's member cap and budget to the new attempt) after the policy's backoff.
 * Not retried: a failure that is the provider's quota (ADR 0033: it is waited out, and spends no retry), an attempt that took an
 * effect permit or lease (the target may have changed), a step whose retry does not name the class that fits its effect, and a
 * step that used its attempts. Returns true when the job was queued again; the caller then fails the job otherwise.
 */
export function retryFailedAttempt(s: Store, input: { jobId: string; attemptId: string; reason: string | undefined }): boolean {
  s.control.prepare("UPDATE jobs SET step_failures=step_failures+1 WHERE id=?").run(input.jobId);
  const { retry, effectClass } = stepPolicy(s, input.jobId);
  if (!retry) return false;
  const { step_failures: failures } = s.control.prepare("SELECT step_failures FROM jobs WHERE id=?").get(input.jobId) as { step_failures: number };
  if (failures >= retry.maxAttempts) return false;
  if (input.reason && quotaLike(input.reason)) return false;
  if (heldEffect(s, input.attemptId)) return false;
  if (!retry.classes.includes(effectClass === "read" ? "transient-read" : "target-proven-absent")) return false;
  const delayMs = Math.min(retry.maxDelayMs, retry.initialDelayMs * 2 ** (failures - 1));
  transitionState(s.control, "job", input.jobId, "queued", { set: { queue_reason: "RETRYING_STEP", ready_at_ms: s.now() + delayMs }, bumpVersion: true });
  return true;
}
