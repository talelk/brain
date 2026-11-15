# 40. A full queue refuses a person's new work at the door

Status: accepted, 2026-11-15. Spec #90, stories 98 and 99.

The job queue was observed (`brain_queue_depth`, Today's "Brain is working on N things") and never bounded, so overload was silent: work piled up and each task waited longer. A limit has to refuse something, and what it refuses decides whether a running mission can be broken by it.

## Decision
1. **Queue** means a workspace's jobs in state `queued` (waiting for a runner). Offered, running and held (`blocked`) jobs are not queue pressure.
2. **The limit is per workspace and set by an administrator**: `workspace.queueLimit.set` (`config:activate`, control authority, 1 to 10000), read back as `queueLimit` in `engineSettings.get` with the current depth. Default 100 when never set: far above what a runner pool leaves waiting in a normal flow, so existing mission and Play flows are unaffected.
3. **What is refused is a person's new work.** The command funnel refuses `mission.create`, `workflow.dispatch`, `session.create` and `result.challenge` when the actor is a human and the queue is at the limit, with `CAPACITY_EXCEEDED` (retryable) and a sentence that says how many tasks wait, the limit, and who can raise it. The check runs after the idempotent-receipt lookup, so a retry of an accepted command still gets its first receipt, and before anything is recorded, so a refusal creates nothing.
4. **Admitted work is never refused.** Auto-start dispatches a mission's ready tasks as the team member's principal (kind agent), so a mission already running keeps starting its tasks past the limit; plan confirmation, evaluator and continuation jobs (`createJobForStep`) and sessions' own commands are untouched. A limit that stranded half a mission would turn overload into failures.
5. **Claiming is untouched.** Placement, per-workspace fairness and mission budget admission (`admit`, the spend cap) decide who runs next; the limit only decides who may join the queue.

## Limits (be honest)
- Scheduled starts (`startFromPlay`, `startFromDescription`, automation runs) do not pass the funnel and are not refused; they are system-started and bounded by their mission budgets and the member cap.
- The check is a count at admission: two simultaneous commands may both pass at limit minus one, so the queue can exceed the limit by the number of concurrent submissions.
- Today does not show the queue's depth before a person submits; the refusal and Administration, How work runs, show it.
