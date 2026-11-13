import type { Store } from "../../application/store";

/**
 * Drain mode: deploys that do not interrupt work. While draining, no new attempt is offered to a runner and nothing new is started
 * automatically; attempts already running finish normally. The flag is stored, so a Governor restart keeps it until resume.
 */
export interface DrainStatus {
  readonly draining: boolean;
  /** Attempts a runner holds right now (offered, running, uploading, verifying): the deploy waits for this to reach zero. */
  readonly runningAttempts: number;
  readonly queuedJobs: number;
  readonly since?: string;
}

export function isDraining(s: Store): boolean {
  return (s.control.prepare("SELECT draining FROM platform_state WHERE singleton=1").get() as { draining: number } | undefined)?.draining === 1;
}

export function drainStatus(s: Store): DrainStatus {
  const row = s.control.prepare("SELECT draining, changed_at_ms FROM platform_state WHERE singleton=1").get() as { draining: number; changed_at_ms: number } | undefined;
  const running = (s.control.prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE state IN ('offered','running','uploading','cancelling','verifying')").get() as { n: number }).n;
  const queued = (s.control.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='queued'").get() as { n: number }).n;
  return { draining: row?.draining === 1, runningAttempts: running, queuedJobs: queued, ...(row?.draining === 1 ? { since: new Date(row.changed_at_ms).toISOString() } : {}) };
}

/** Starts or ends the drain. Idempotent. Runs inside the caller's control transaction. */
export function setDraining(s: Store, actorId: string, draining: boolean): DrainStatus {
  s.control.prepare(`INSERT INTO platform_state(singleton,draining,changed_by,changed_at_ms) VALUES (1,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET draining=excluded.draining,changed_by=excluded.changed_by,changed_at_ms=CASE WHEN platform_state.draining=excluded.draining THEN platform_state.changed_at_ms ELSE excluded.changed_at_ms END`)
    .run(draining ? 1 : 0, actorId, s.now());
  return drainStatus(s);
}
