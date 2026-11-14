# 34. A success criterion has a stable id, and a plan task names the ones it serves

Status: accepted, 2026-11-14.

A mission's success criteria were an array of strings, so nothing could point at one: progress was a count of tasks, and a person could not tell which outcome was still unproven. Plan tasks already carry `criteria`, which are that task's own acceptance criteria and a different thing.

## Decision
1. A mission's success criteria are stored as `{ id, text }`. Ids are `c1`, `c2`, ... by position when the mission is created and are never renumbered or reused. Criteria are not edited after creation (a brief edit changes intent and constraints only), so ids are the same in every brief version and plan version. `mission.create` and Plays still take plain text; the Governor assigns the ids. A Play's tasks name `c1..cN` of that Play.
2. A plan task may name `criterionIds`, the success criteria it serves. `plan.propose` and `plan.confirm` refuse an id the mission does not have; the Play compiler refuses one outside the Play's own list.
3. A criterion is covered when at least one task of the confirmed plan serves it and every serving task's latest work item is done. Coverage is read from the confirmed plan's tasks and the latest live work item per task, never from `work_items.plan_version_id` (a retained item keeps its old version). It is derived, never stored, and sits on the mission read as `successCriteria[].state` with `serving: { total, done }`. `total` 0 means no task serves the criterion, which the page says apart from "not done yet".
4. Changing only which criteria a task serves is not a change to the work: it is allowed on started work and keeps the work item. It still needs `task.change` from an agent, so a coordinator cannot claim coverage by relinking finished work without the policy allowing it.
5. The mission page lists every criterion on every tab with Covered or Not covered; the plan editor offers the mission's criteria as checkboxes per step. The plan assistant is given each criterion as `c1: text` and names the ids a task serves.

Checks that prove a criterion (per-criterion evidence on the sign-off view) build on these ids and are not part of this decision.
