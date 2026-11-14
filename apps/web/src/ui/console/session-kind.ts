import type { BrainSession, JobSnapshot } from "@brain/contracts";

/** The runner group that carries independent checks: a session whose job ran there is the reviewer, never the worker. */
const CHECK_GROUP = "evaluators";

/** True when the session belongs to an independent check of a result (its job was placed on the evaluators). Unknown jobs count as work. */
export function isCheckSession(session: Pick<BrainSession, "jobId">, jobs: readonly Pick<JobSnapshot, "jobId" | "placement">[]): boolean {
  return session.jobId !== undefined && jobs.find((job) => job.jobId === session.jobId)?.placement.group === CHECK_GROUP;
}

/** The session a mission's console opens on when nothing is running: the newest piece of work, not the check that reviewed it. */
export function preferredSession<T extends Pick<BrainSession, "jobId">>(sessions: readonly T[], jobs: readonly Pick<JobSnapshot, "jobId" | "placement">[]): T | undefined {
  return sessions.find((session) => !isCheckSession(session, jobs)) ?? sessions[0];
}
