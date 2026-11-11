# 17. A schedule confirms a repeated plan only under safety conditions

Date: 2026-11-11
Status: Accepted (backlog row 59). Amends the Play rule of #37 ("a scheduled Play's plan waits for a person") for repeats.

Live finding: "Repeat this" told the person "You confirm its plan, as you did the first time", so a recurring job needed a human every occurrence. That is not hands-off.

**Decision.** An occurrence created by "Repeat this" is a real mission (ADR 0004) whose budget, autonomy and plan come from the mission the schedule repeats (`input.sourceMissionId`). Its plan is confirmed by the schedule, on behalf of the person who created the schedule, when every condition holds:

1. The schedule's switch "Confirm the plan automatically each time" is on (`input.autoConfirm`, default on).
2. The mission it repeats is closed as achieved and its latest evidence bundle is verified.
3. The plan the occurrence would run is identical to that mission's confirmed plan: the same tasks (title, criteria, dependencies, workflow, assignment, optional) and the same team, compared as canonical JSON. A Play that was re-planned since is therefore not identical.
4. No step of any task's workflow (following subgraphs) waits for an approval (`gate`), merges, steers a live session, or dispatches with an effect class other than `read`. A workflow missing from the active release counts as not safe. Release compilation already forces a gate in front of effectful steps, so in practice an effectful task always stops here.
5. The mission's autonomy preset is `standard` or `autonomous`.
6. The new mission has headroom: no money, token, time or workspace-cap limit is already reached.
7. The person who created the schedule is still an enabled human who holds `mission:write` in the workspace.

**When a condition fails** the plan stays a proposal, exactly as before, and the run waits in Needs you as a normal plan proposal titled "<mission> needs your OK: <reason>". The reason, and for condition 3 the task-level diff against the confirmed plan, is stored on the plan as the event `plan.heldBySchedule` (nothing is added to the schema); confirming it is the ordinary `plan.confirm` by a person.

**Audit.** Both outcomes are events on the plan, which is the workspace audit trail: `plan.confirmedBySchedule` with the note "confirmed by schedule <id> created by <person>" (actor `schedule:<id>`), or `plan.heldBySchedule` with the reason.

**Budget and time.** The occurrence copies the source's budget as confirmed, and whether a person named its time limit, so the working-time rules of ADR 0016 apply unchanged at confirmation. Money, tokens and caps are never raised.

**Atomicity.** The mission, its plan, the gate decision and the confirm-or-hold event are one transaction, keyed by the occurrence id. A crash and replay yields one mission and one decided plan; a chaos test replays the start after a restart.

**Failures are visible.** A schedule whose latest occurrence failed to start, or whose latest mission ended without reaching its goal, appears in Needs you (`schedule-failed`, derived and self-clearing when a later run starts) in addition to the schedule's history, which links to each occurrence's mission. A mission that only waits for a person's sign-off on verified evidence no longer counts as open for the schedule's "skip if still running" rule, so one unsigned run does not stop the next.

**Rejected.** Confirming whenever the person scheduled it (the previous behaviour for described work): scheduling approves a description once, not a plan whose tools, team or workflow may have changed since. Confirming effectful work: that always keeps its approval gates.
