# 12. "Challenge this result" is an independent reviewer pass that only writes claims

Date: 2026-11-11
Status: Accepted (issue #50)

A person who doubts a finished result needs a cheap second look. The open questions were who the reviewer is, how independent it is, and how its findings relate to the verdict.

**Reviewer role.** The Skeptic is not a new agent. A challenge is an ordinary governed run of the existing general task workflow (`general-task`: the `task-worker` agent, checked by the same `task.validate` evaluator), dispatched through `workflow.dispatch` like any other run. Its brief is the finished result quoted as data (the same bounded excerpt format that downstream tasks receive) plus three fixed criteria: list up to five weak claims, say what would settle each, and say plainly if nothing looks weak. Reusing the evaluator path means no new agent definition, no release re-pin and no new trust surface: the answer's shape is validated by the same deterministic evaluator, and the run is visible in Live and Logs.

**Independence.** Level L1, stated on every finding: a separate run with a fresh context that has not seen the author's session, but possibly the same model. It is labelled "one model's opinion, not a check". We do not claim more independence than that; a different model or a human reviewer would be a stronger level and a later change to the workflow, not to this feature.

**Never a verdict.** The run is bound to no work item (no execution link), so it can never be an attempt, change a task's state, evidence or version, create a mission bundle or verdict, or move the mission. Its answer is parsed into claims (bullet lines of the written answer, at most ten of 600 characters) and stored in `result_challenges` beside the result with the reviewer's own summary. The done gate and the Quality figures never read it. Tests assert that work item state, evidence digest, version, verdicts, bundles and mission state are byte-identical after a challenge succeeds and after one fails.

**Flow and limits.** `result.challenge` (scope `mission:write`) only records a request; one challenge per result may be in flight (a unique partial index). The maintenance pass starts the run (command id derived from the challenge id, so a replay starts nothing twice) and collects its answer; a crash at any point leaves a request that the next pass finishes. A reviewer run that fails, is cancelled or does not answer in 30 minutes marks the challenge failed with a plain reason. The task must be finished (review or done) and have a written result.

**Cost.** A challenge run is bound to no work item, so the mission budget and the usage ledger (which key spend to a mission through a work item) do not cover it. It does honour the workspace spend cap: asking is refused, and a request is failed, while the cap is reached. It is otherwise bounded by the workflow's own caps. Charging it to its mission is a recorded leftover.
