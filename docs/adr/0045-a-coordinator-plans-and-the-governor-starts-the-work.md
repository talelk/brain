# 45. A coordinator plans and the Governor starts the work

Status: accepted, 2026-11-15. Spec #90, story 30 to 32. Amends the last paragraph of ADR 0004. Builds on ADR 0003, 0032 and 0042.

No Play declared a coordinator, so its path had never run. Running it showed that a coordinated mission started nothing: auto-start, auto-completion and mission completion all skipped missions with a coordinator ("the coordinator owns dispatch"), and a session cannot dispatch (ADR 0032, the session allowlist). The coordinator also woke blind: its run serves no work item, so it had no context pack and could not repeat the started tasks a plan version must keep.

## Decision
1. **A coordinator plans; the Governor starts.** Ready work of a coordinated mission starts, and finishes, exactly like any mission's: as the member's principal, under the autostart switch, the member cap and the budget. The coordinator's one lever is the plan, through `mission.propose-plan` (ADR 0042).
2. **The first plan is the person's.** A Play's plan is the mission's starting plan version and waits for a person like any first plan. Confirming it wakes the coordinator (`plan-resolved`); its proposal is the next version and, inside the autonomy policy, confirms itself. Later wakes are the existing events: a verified task, a message to the mission, a resolved proposal, a budget change.
3. **A coordinator pack.** Its run gets a context pack of the mission, built by the Governor from declared sections: brief, success criteria as `c1: words`, autonomy policy, team, confirmed plan as JSON, where each task stands, finished tasks' handoff notes (claim), proposals waiting for a person, messages to the mission (claim). The manifest names the mission instead of a work item. Messages shown count as delivered.
4. **The last outcome can still re-plan.** A coordinated mission is not proposed for completion while a wake is pending or a coordinator run is live.
5. **Its session is mission-level.** A coordinator attempt's session carries `missionId` (no work item), so Live shows it under the coordinator member.
6. **A re-plan keeps finished work.** A task's latest live work item is kept for an unchanged task whatever plan version made it; before, the second re-plan of a mission started finished tasks again.
7. **The starter Play** "Research and write, planned by a coordinator" has a `lead` coordinator on `plan-coordinator` (tools: `mission.propose-plan`, `mission.message-member`) and a `researcher`. Its workflow `coordinator-session` is the coordinator run: one agent step and the starter's independent validator (L1), which now knows the kind `coordinator-session`.

## Limits
- Each wake costs one agent attempt and one validator attempt. Wakes that arrive while a run is live coalesce into the next one.
- A coordinator with no runner leaves wakes pending and the mission uncompleted; a person can still propose completion.
- The fixture engine's coordinator is a scripted stand-in; what a real model proposes is its own and is bounded by the same gates.
