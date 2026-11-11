import type { JsonValue } from "@brain/contracts";
import { transitionState } from "../../domain/states";
import type { Store } from "../../application/store";
import { interruptionTotal, isReadOnlyReasoningJob, releaseReservation, restartBudgetLeft, restartInterruptedReadJob } from "./attempts";

/**
 * Stuck-job watchdog. The lease sweep only sees attempts whose lease ran out;
 * it cannot see a job that nobody holds any more yet that no event will ever
 * move: a finished author attempt waiting for evidence that was never
 * accepted (the runner stopped after completing), or a job marked running or
 * offered whose attempt is gone. Such a job is restarted when it is a
 * read-only agent or evaluator step. A read-only step that has used up its
 * restarts waits out a short cooldown, gets one more automatic try, and then
 * stops with a plain "interrupted N times; try again" failure that parks the
 * task for a person (Needs you). A step that may have started an outside
 * effect stays "outcome unknown" for a person. It never stays silent. A repeat
 * pass finds nothing to do: every action moves the job out of the states it scans.
 */

export const DEFAULT_STUCK_MINUTES = 15;

/** Minutes of silence after which a job is considered stuck; BRAIN_STUCK_JOB_MINUTES overrides the default. */
export function stuckJobMs(): number {
  const minutes = Number(process.env["BRAIN_STUCK_JOB_MINUTES"] ?? DEFAULT_STUCK_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_STUCK_MINUTES) * 60_000;
}

interface Candidate {
  id: string; organization_id: string; workspace_id: string; workflow_run_id: string; step_id: string; state: string; job_fence: number;
  attempt_counter: number; last_ms: number;
}

const LIVE_ATTEMPT_STATES = "('offered','running','uploading','cancelling')";

export const DEFAULT_PARKED_COOLDOWN_SECONDS = 60;

/** Seconds a read-only job whose restarts are used up waits before its one extra automatic try; BRAIN_PARKED_COOLDOWN_SECONDS overrides it. */
export function parkedCooldownMs(): number {
  const seconds = Number(process.env["BRAIN_PARKED_COOLDOWN_SECONDS"] ?? DEFAULT_PARKED_COOLDOWN_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_PARKED_COOLDOWN_SECONDS) * 1000;
}

export function sweepStuckJobs(s: Store, deps: { completeStep: (organizationId: string, workspaceId: string, runId: string, stepId: string, output: JsonValue, ok: boolean) => void }, stuckMs: number = stuckJobMs()): number {
  const now = s.now();
  const candidates = s.control.prepare(`SELECT j.id, j.organization_id, j.workspace_id, j.workflow_run_id, j.step_id, j.state, j.job_fence, j.attempt_counter,
      COALESCE((SELECT MAX(MAX(COALESCE(a.lease_expires_at_ms,0), COALESCE(a.offer_expires_at_ms,0))) FROM job_attempts a WHERE a.job_id=j.id), j.ready_at_ms) AS last_ms
    FROM jobs j
    WHERE j.state IN ('offered','running','verifying')
      AND NOT EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id=j.id AND a.state IN ${LIVE_ATTEMPT_STATES} AND COALESCE(a.lease_expires_at_ms, a.offer_expires_at_ms, 0) > ?)
    ORDER BY j.id LIMIT 200`).all(now) as unknown as Candidate[];
  let handled = 0;
  const failures: Array<{ job: Candidate; message: string }> = [];
  for (const job of candidates) {
    if (now - job.last_ms < stuckMs) continue;
    const minutes = Math.max(1, Math.round((now - job.last_ms) / 60_000));
    const done = s.inTx(s.control, () => handleStuck(s, job, minutes, now));
    if (done) handled++;
  }
  handled += sweepLeftJobs(s, now, failures);
  for (const { job, message } of failures) {
    deps.completeStep(job.organization_id, job.workspace_id, job.workflow_run_id, job.step_id, { error: message, code: "AGENT_INTERRUPTED" } as unknown as JsonValue, false);
  }
  return handled;
}

/**
 * Read-only reasoning jobs left "outcome unknown" because their restarts are used up. After the cooldown the job is
 * queued once more; if that last try is interrupted too, the step is failed with a plain reason so the task parks and
 * appears in Needs you with a one-click Try again. Effectful steps are never touched here.
 */
function sweepLeftJobs(s: Store, now: number, failures: Array<{ job: Candidate; message: string }>): number {
  const cooldown = parkedCooldownMs();
  const left = s.control.prepare(`SELECT j.id, j.organization_id, j.workspace_id, j.workflow_run_id, j.step_id, j.state, j.job_fence, j.attempt_counter, j.auto_retries,
      COALESCE((SELECT MAX(MAX(COALESCE(a.lease_expires_at_ms,0), COALESCE(a.offer_expires_at_ms,0))) FROM job_attempts a WHERE a.job_id=j.id), j.ready_at_ms) AS last_ms,
      (SELECT a.id FROM job_attempts a WHERE a.job_id=j.id AND a.job_fence=j.job_fence ORDER BY a.attempt_no DESC LIMIT 1) AS attempt_id
    FROM jobs j WHERE j.state='outcome_unknown' ORDER BY j.id LIMIT 200`).all() as unknown as Array<Candidate & { auto_retries: number; attempt_id: string | null }>;
  let handled = 0;
  for (const job of left) {
    if (!job.attempt_id || now - job.last_ms < cooldown) continue;
    const done = s.inTx(s.control, () => {
      const current = s.control.prepare("SELECT state, job_fence FROM jobs WHERE id=?").get(job.id) as { state: string; job_fence: number } | undefined;
      if (!current || current.state !== "outcome_unknown" || current.job_fence !== job.job_fence) return false;
      if (!isReadOnlyReasoningJob(s, job.id, job.attempt_id as string)) return false;
      const attempt = s.control.prepare("SELECT state FROM job_attempts WHERE id=?").get(job.attempt_id) as { state: string };
      const wasUnknown = attempt.state === "outcome_unknown";
      const budget = restartBudgetLeft(s, job.id, job.attempt_id as string);
      if (budget || job.auto_retries < 1) {
        if (wasUnknown) transitionState(s.control, "attempt", job.attempt_id as string, "failed");
        if (!budget) s.control.prepare("UPDATE jobs SET auto_retries=auto_retries+1 WHERE id=?").run(job.id);
        transitionState(s.control, "job", job.id, "queued", { set: { queue_reason: "RESTARTED_AFTER_INTERRUPTION" }, bumpVersion: true });
        releaseReservation(s, job.attempt_id as string);
        return noteStuck(s, job, "The agent was interrupted again; Brain is trying once more.", now);
      }
      if (wasUnknown) transitionState(s.control, "attempt", job.attempt_id as string, "failed");
      transitionState(s.control, "job", job.id, "failed", { bumpVersion: true });
      releaseReservation(s, job.attempt_id as string);
      const times = interruptionTotal(s, job.id);
      const message = `The agent was interrupted ${times} times; try again.`;
      failures.push({ job, message });
      return noteStuck(s, job, message, now);
    });
    if (done) handled++;
  }
  return handled;
}

function handleStuck(s: Store, job: Candidate, minutes: number, now: number): boolean {
  const current = s.control.prepare("SELECT state, job_fence FROM jobs WHERE id=?").get(job.id) as { state: string; job_fence: number } | undefined;
  if (!current || current.state !== job.state || current.job_fence !== job.job_fence) return false;
  const attempt = s.control.prepare("SELECT id, state FROM job_attempts WHERE job_id=? AND job_fence=? ORDER BY attempt_no DESC LIMIT 1").get(job.id, job.job_fence) as { id: string; state: string } | undefined;

  if (job.state === "offered") {
    // An offer nobody took and no live attempt: the job goes back to the queue.
    if (attempt && attempt.state === "offered") { transitionState(s.control, "attempt", attempt.id, "expired"); releaseReservation(s, attempt.id); }
    transitionState(s.control, "job", job.id, "queued", { set: { queue_reason: "WAITING_FOR_RUNNER" }, bumpVersion: true });
    return true;
  }

  if (job.state === "verifying") {
    if (!attempt || attempt.state !== "verifying") return false;
    const ws = s.workspaceDb(job.workspace_id, job.organization_id);
    const run = ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(job.workflow_run_id) as { state: string } | undefined;
    if (!run || !["running", "suspended"].includes(run.state)) return false;
    // Evidence on its way (or already accepted) is the evidence loop's work, not a stall.
    if (ws.prepare("SELECT 1 FROM evidence_bundles WHERE job_id=? AND attempt_id=?").get(job.id, attempt.id)) return false;
    // A verifying job only waits for something when an evaluator step is still to be admitted for it.
    if (!ws.prepare("SELECT 1 FROM workflow_steps WHERE run_id=? AND state='pending' AND job_id IS NULL").get(job.workflow_run_id)) return false;
    if (s.control.prepare("SELECT 1 FROM jobs WHERE workflow_run_id=? AND id<>? AND state IN ('queued','offered','running')").get(job.workflow_run_id, job.id)) return false;
  }

  if (attempt && ["running", "verifying", "uploading"].includes(attempt.state)) transitionState(s.control, "attempt", attempt.id, "outcome_unknown");
  const attemptEnded = !!attempt && ["failed", "expired", "declined", "cancelled", "succeeded"].includes(attempt.state);
  if (job.state === "running" && attemptEnded && attempt && isReadOnlyReasoningJob(s, job.id, attempt.id) && restartBudgetLeft(s, job.id, attempt.id)) {
    // The attempt already ended without moving the job; the job simply queues again.
    transitionState(s.control, "job", job.id, "queued", { set: { queue_reason: "RESTARTED_AFTER_INTERRUPTION" }, bumpVersion: true });
    return noteStuck(s, job, `The agent stopped responding after ${minutes} minutes; Brain restarted it.`, now);
  }
  transitionState(s.control, "job", job.id, "outcome_unknown", { bumpVersion: true });
  const attemptId = attempt?.id;
  let reason: string;
  if (attemptId && restartInterruptedReadJob(s, job.id, attemptId)) {
    reason = `The agent stopped responding after ${minutes} minutes; Brain restarted it.`;
  } else if (attemptId && isReadOnlyReasoningJob(s, job.id, attemptId)) {
    // Restarts used up: the job waits out a short cooldown and is retried once more, then handed to a person (sweepLeftJobs).
    reason = `The agent stopped responding after ${minutes} minutes and its restarts are used up; Brain will try once more, then ask you.`;
  } else {
    reason = `The step stopped responding after ${minutes} minutes and could not be restarted: it may have started an outside effect, so a person has to check it.`;
  }
  return noteStuck(s, job, reason, now);
}

function noteStuck(s: Store, job: Candidate, reason: string, now: number): boolean {
  const after = s.control.prepare("SELECT state FROM jobs WHERE id=?").get(job.id) as { state: string };
  s.emit(s.control, { organizationId: job.organization_id, workspaceId: job.workspace_id, aggregateType: "job", aggregateId: job.id, eventType: "job.updated", payload: { jobState: after.state, reason, watchdog: true, at: now }, destinations: [`workspace:${job.workspace_id}`] });
  return true;
}
