import type { ActorContext } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";

/**
 * The queue-depth limit (ADR 0038). A workspace's queue is the jobs waiting for a runner. The limit refuses a person's new work at the
 * door, with the reason; it never touches work already admitted: continuation steps, a mission's auto-started tasks, evaluator jobs and scheduled starts keep their
 * course, and claiming (placement, fairness, mission budget admission) is not involved.
 */
const DEFAULT_QUEUE_LIMIT = 100;

/** The commands with which a person starts new work that queues jobs. */
const WORK_STARTING_COMMANDS: ReadonlySet<string> = new Set(["mission.create", "workflow.dispatch", "session.create", "result.challenge"]);

interface QueueLimitView { readonly maxQueued: number; readonly queued: number; readonly isDefault: boolean }

/** The workspace's limit, the jobs waiting for a runner now, and whether the limit is the documented default. */
export function queueLimitOf(s: Store, workspaceId: string): QueueLimitView {
  const row = s.control.prepare("SELECT max_queued FROM workspace_queue_limit WHERE workspace_id=?").get(workspaceId) as { max_queued: number } | undefined;
  const queued = (s.control.prepare("SELECT COUNT(*) AS n FROM jobs WHERE workspace_id=? AND state='queued'").get(workspaceId) as { n: number }).n;
  return { maxQueued: row?.max_queued ?? DEFAULT_QUEUE_LIMIT, queued, isDefault: row === undefined };
}

export function setQueueLimit(s: Store, input: { organizationId: string; workspaceId: string; maxQueued: number; actorId: string }): void {
  s.control.prepare(`INSERT INTO workspace_queue_limit(workspace_id,organization_id,max_queued,updated_by,updated_at_ms) VALUES (?,?,?,?,?)
    ON CONFLICT(workspace_id) DO UPDATE SET max_queued=excluded.max_queued,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`)
    .run(input.workspaceId, input.organizationId, input.maxQueued, input.actorId, s.now());
}

/**
 * Refuses a person's command that starts new work while the workspace's queue is at its limit; any other command passes. Work the
 * Governor starts for a mission it already admitted (auto-start dispatches as the team member's principal) is not a person's new work.
 */
export function assertQueueAdmits(s: Store, actor: ActorContext, commandType: string, workspaceId: string): void {
  if (actor.kind !== "human" || !WORK_STARTING_COMMANDS.has(commandType)) return;
  const { maxQueued, queued } = queueLimitOf(s, workspaceId);
  if (queued < maxQueued) return;
  throw new BrainDomainError("CAPACITY_EXCEEDED",
    `This workspace already has ${queued} ${queued === 1 ? "task" : "tasks"} waiting for a runner, which is its queue limit (${maxQueued}). Nothing new is accepted until some start; wait a little, or ask an administrator to raise the queue limit under Administration, How work runs.`,
    { retryable: true });
}
