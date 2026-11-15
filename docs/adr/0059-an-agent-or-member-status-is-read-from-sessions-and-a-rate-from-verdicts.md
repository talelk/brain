# 59. An agent's or member's status is read from its sessions and its verified rate from verdicts

Date: 2026-11-15
Status: Accepted

Extends ADR 0051 and ADR 0014. The agent page (Library, `/w/:id/library/agents/:agentId`) and the team-member panel (mission Team tab, `?member=`) read `agents.profile` and `members.profile`; cost is `usage.agent` and `usage.member`.

- **Status is derived, never stored**, like a mission's condition. The first that holds: working (a session of it is starting, running or stopping), waiting (one is waiting for a person or an answer), failing (its latest ended session failed), else idle. No table holds it; each read recomputes it from session records, and the reply carries the definition.
- **A session names its agent.** A runner-created session used to carry an empty agent; it now takes the agent definition stamped on the attempt's reservation when the Governor claimed the job (ADR 0051), so nothing the model says is read. A member is the ledger's member for the attempt, else the task's assignee.
- **The verified rate counts verdicts, not Done transitions.** Over the last 30 days, of the results (evidence bundles) of the agent's attempts that an independent check judged, the share whose latest verdict is verified. An attempt with no result or an unjudged result is not counted; the page shows "no judged results yet" instead of a number.
- **Failure classes count failed task runs once** (`task_failures`, one row per run and task) for the attempts the ledger charged to the agent or member.
- Every figure ships its definition; no model computes or tunes anything. The profile reads only Governor records: no runner id, host or engine internals.
