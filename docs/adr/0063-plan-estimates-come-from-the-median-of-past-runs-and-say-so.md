# 63. Plan estimates come from the median of past runs and say so

Date: 2026-11-15
Status: Accepted

Replaces "a plan estimate adds up what the planner declared" (#54). The Governor's `plans.estimate` now
derives each task's time and cost from what this workspace has already done, with no new store.

- Sample: a Done work item of another mission with at least one settled attempt in the usage ledger. Cost
  is the sum its attempts settled. Time is the span of its attempts from the ledger's reservation (the
  claim) to the release of the runner's capacity (the attempt's end), not the ledger's settlement time,
  because settlement runs later on a read or sweep.
- Basis per task, first that applies: the same Play task (same Play, same task id) with at least 3 runs;
  else the same way of working (the task's workflow, else the workspace default, else the general task
  workflow, as ADR 0022; a task given to a team member's agent has none of its own) with at least 3 runs;
  else what the planner declared; else unknown. Only the newest 25 runs count. The value is the median
  (linear interpolation, rounded); from 4 runs the 25th and 75th percentile are the range. Plan totals sum
  tasks that have a figure and count the rest as unknown; the range sums each task's range.
- Every figure carries its basis (`history` with run count and source, `declared`, `unknown`; a total over
  different bases is `mixed`), and the UI states it.
- Deterministic only: nothing a model says is read or tuned. The estimate never changes a budget. When
  history informs it the Governor also returns a suggested dollar budget (the high end of the range plus the
  final allowance) and time limit (three times the high end, ADR 0016's factor); Change limits shows them
  with a "Use suggested" button that only fills the field. Confirming a plan still raises a default time
  limit from declared minutes alone (ADR 0016).
