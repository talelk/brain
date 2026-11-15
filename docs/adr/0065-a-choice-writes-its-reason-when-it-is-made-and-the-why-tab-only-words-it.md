# 65. A choice writes its reason when it is made, and the Why tab only words it

Status: accepted, 2026-11-15. Extends the run's placement explanation (job.explain), which judged only where a job could run.

A person looking at a run could learn why it sat in the queue but not why it ran on this way of working, with this team member, on this model route. Rebuilding those answers afterwards from today's routes, team and release would describe a world that may have changed.

## Decision
1. Each choice records a **choice reason** at the moment it is made: a small row in `choice_reasons` with a kind (`way-of-working`, `team-member`, `model-route`), the subject it was for (a dispatch command, a work item, a job or an attempt), a code and the facts judged, as they were then.
2. Rows are immutable (a trigger refuses updates) and a later decision adds a row; `(subject, kind, code)` is unique so a replay keeps the first. A choice nobody made leaves no row: a run a person started by hand has no way-of-working reason, a task nobody assigned has no member reason, a self-hosted job has no route reason.
3. Where each is written: auto-start writes the way of working just before it dispatches (the chosen workflow, where it came from, every workflow ruled out and why: missing tool, not in the release, no input schema, input refused), keyed by the start's command id, which the run keeps as its execution key. Plan confirmation writes the team member when it creates the work item, from the facts `assertTeamEligible` judged (agent, engine, tools, spend caps, other eligible members). The first offer of a job writes the model route (the route handed first, its place in the owner's order, its cost tier, the routes behind it and every route left out with why) and a job that must wait writes that once. The runner's report writes which route answered an attempt.
4. `job.explain` returns `choices` beside the placement verdict, read from those rows only. The web words each code from the facts with plain sentences; no model writes any of it. Placement stays a live judgement of the fleet.

## Consequences
- The explanation of a run does not move when the owner reorders routes, changes the way of working or reassigns the task; a new decision shows as a new row.
- No backfill: runs made before this change show no choices.
