import { transitionState } from "../../domain/states";
import type { Store } from "../../application/store";
import { revokeAttemptSecrets, revokeWorkspaceSecrets } from "../secret-leases/index";
import { revokeSessionCredentials, revokeWorkspaceSessionCredentials } from "../identity/index";
import { endAttemptSession } from "../sessions/index";
import { markPlatformInterruption, releaseReservation } from "./attempts";

/**
 * Stop all sessions (ADR 0047): every attempt a runner holds in the workspace is fenced and ended, its effect permits and session credentials are
 * revoked, and the jobs nobody holds yet are cancelled. The workspace itself stays active: people keep reading, deciding and resuming. The fence
 * is the same one a lease loss uses: the attempt's job fence moves on, so the runner's renew, events, completion, permit and credential calls all
 * answer LEASE_LOST from then on. An attempt whose effect had started is never claimed settled: it is left "outcome unknown" for a person.
 */
export interface StoppedAttempt { attemptId: string; jobId: string; runId: string; stepId: string; outcome: "cancelled" | "unknown" }
export interface StoppedWork { attempts: StoppedAttempt[]; runIds: string[]; waitingJobs: number }

const LIVE = "('offered','running','uploading','cancelling')";

/** An effect of the attempt that already started: its outcome is unobserved, so the attempt cannot be called cancelled. */
function effectMayHaveStarted(s: Store, attemptId: string): boolean {
  const row = s.control.prepare("SELECT COUNT(*) AS n FROM effect_permits WHERE attempt_id=? AND state NOT IN ('issued','revoked')").get(attemptId) as { n: number };
  return row.n > 0;
}

export function stopWorkspaceWork(s: Store, input: { organizationId: string; workspaceId: string }): StoppedWork {
  return s.inTx(s.control, () => {
    const now = s.now();
    const live = s.control.prepare(`SELECT a.id AS attempt_id, a.state AS attempt_state, j.id AS job_id, j.workflow_run_id AS run_id, j.step_id AS step_id
      FROM job_attempts a JOIN jobs j ON j.id=a.job_id WHERE j.organization_id=? AND j.workspace_id=? AND a.state IN ${LIVE} ORDER BY a.id`).all(input.organizationId, input.workspaceId) as
      Array<{ attempt_id: string; attempt_state: string; job_id: string; run_id: string; step_id: string }>;
    const attempts: StoppedAttempt[] = [];
    const runIds = new Set<string>();
    for (const row of live) {
      const unknown = effectMayHaveStarted(s, row.attempt_id);
      // The fence moves first: the attempt's stored fence no longer matches its job's, whatever state either is left in.
      if (unknown) {
        markPlatformInterruption(s, row.attempt_id);
        transitionState(s.control, "attempt", row.attempt_id, "outcome_unknown");
        transitionState(s.control, "job", row.job_id, "outcome_unknown", { rawSet: ["job_fence=job_fence+1"], bumpVersion: true });
      } else {
        if (row.attempt_state === "offered") transitionState(s.control, "attempt", row.attempt_id, "declined");
        else {
          if (row.attempt_state !== "cancelling") transitionState(s.control, "attempt", row.attempt_id, "cancelling");
          transitionState(s.control, "attempt", row.attempt_id, "cancelled");
        }
        transitionState(s.control, "job", row.job_id, "cancelled", { rawSet: ["job_fence=job_fence+1"], bumpVersion: true });
        // A permit that was issued and never used dies with the attempt, and frees what it guarded; an effect that started is reconciled, not freed.
        s.control.prepare("UPDATE effect_permits SET state='revoked' WHERE attempt_id=? AND state='issued'").run(row.attempt_id);
        s.control.prepare("UPDATE resource_leases SET unresolved_effect=0, expires_at_ms=? WHERE attempt_id=?").run(now, row.attempt_id);
      }
      s.control.prepare("UPDATE permit_credentials SET revoked_at_ms=? WHERE revoked_at_ms IS NULL AND permit_id IN (SELECT id FROM effect_permits WHERE attempt_id=?)").run(now, row.attempt_id);
      revokeSessionCredentials(s, row.attempt_id);
      revokeAttemptSecrets(s, row.attempt_id, "stop-all");
      releaseReservation(s, row.attempt_id);
      endAttemptSession(s, { organizationId: input.organizationId, workspaceId: input.workspaceId, attemptId: row.attempt_id, failed: false });
      s.emit(s.control, { organizationId: input.organizationId, workspaceId: input.workspaceId, aggregateType: "job", aggregateId: row.job_id, eventType: "job.updated", payload: { attemptId: row.attempt_id, jobState: unknown ? "outcome_unknown" : "cancelled", stopped: true }, destinations: [`workspace:${input.workspaceId}`] });
      attempts.push({ attemptId: row.attempt_id, jobId: row.job_id, runId: row.run_id, stepId: row.step_id, outcome: unknown ? "unknown" : "cancelled" });
      runIds.add(row.run_id);
    }
    // Jobs no runner holds yet (queued, or blocked while a person decides a change) would start again the moment the missions resume: they go too.
    const waiting = s.control.prepare("SELECT id, workflow_run_id AS run_id FROM jobs WHERE organization_id=? AND workspace_id=? AND state IN ('queued','offered','blocked') ORDER BY id").all(input.organizationId, input.workspaceId) as Array<{ id: string; run_id: string }>;
    for (const job of waiting) {
      transitionState(s.control, "job", job.id, "cancelled", { rawSet: ["job_fence=job_fence+1"], bumpVersion: true });
      runIds.add(job.run_id);
    }
    // Credentials of this workspace's machine principals that no live attempt carries any more (a replaced or half-ended session) end as well.
    revokeWorkspaceSessionCredentials(s, input.workspaceId);
    revokeWorkspaceSecrets(s, input.workspaceId, "stop-all");
    return { attempts, runIds: [...runIds].sort(), waitingJobs: waiting.length };
  });
}
