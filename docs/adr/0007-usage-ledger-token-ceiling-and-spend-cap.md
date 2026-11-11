# 7. Usage ledger, token ceiling and workspace spend cap

Date: 2026-11-11
Status: Accepted

Local models report zero dollars, so a dollar budget never binds them and tokens were
visible only inside attempt events. Decisions:

- The usage ledger is the per-attempt row in `mission_spend`, written at settlement:
  input, output and cached tokens, micro-USD, accounting (`final-total` or `incremental`)
  and an estimated flag. A final total replaces earlier reports; incremental reports count
  each usage id once. Totals for run, task, mission and workspace are reads over that one
  table (`usage.run`, `usage.task`, `usage.mission`, `usage.workspace`); the browser never sums.
- "Tokens" means input plus output plus cache-read tokens, the same sum the engines check
  against their per-attempt token limit. The cache share is shown separately.
- The mission token ceiling (`MissionBudget.maxTokens`, optional `attemptReserveTokens`) is
  enforced where admission enforces dollars: settled plus reserved tokens that reach the
  ceiling, or would pass it with one more reserve, refuse admission and pause the mission with
  reason `budget`. The coordinator is exempt so a paused mission can still write its final
  checkpoint. Absent ceiling behaves as before.
- The workspace spend cap (`workspace.spendCap.set`, daily and weekly micro-USD) sums settled
  spend over rolling 24 hours and 7 days plus every open reservation; reaching it pauses
  admission the same way. Rolling windows need no scheduler and are deterministic. Raising or
  clearing the cap is an audited command; the mission is then resumed by a human.
- Plan estimates (`plans.estimate`) total only declared values; a task without an estimate is
  counted as unknown, never zero. The ceiling shown is the mission budget as admission enforces
  it (dollar budget less the coordinator's final allowance).

Interactive runs outside a mission (ad-hoc task runs, conversations) are recorded in the workspace
bucket `workspace_spend` ("Outside missions"): same columns and settlement as `mission_spend`, no
mission. They are part of run and workspace totals and of the spend cap, and a reached cap holds new
interactive attempts too (queue reason "waiting: workspace spend cap"). They have no mission budget,
so only the cap and the agent's own limits bound them.

The spend cap is a workspace-wide limit set with the `mission:write` scope, like a mission budget, so
the person who sees a mission pause can raise it in one step. It is audited as a command. Narrowing
that to an administration scope is possible later without changing the data model.
