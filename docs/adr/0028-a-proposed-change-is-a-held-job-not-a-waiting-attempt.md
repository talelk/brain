# 28. A proposed change is a held job, not a waiting attempt

Status: accepted, 2026-11-13. Replaces the section "Why not hold the attempt's approval outside the runner" of ADR 0024; every other guarantee of 0024 stands.

## Decision
1. **A proposal ends the attempt.** The agent proposes a change; the Governor records the approval and the call (`effect_calls`) and tells the agent it is held. The agent finishes its report and the attempt completes with `held`: it holds no slot and no lease while people decide (an overnight schedule costs nothing), and its job waits `blocked` (`AWAITING_APPROVAL`). It writes no evidence yet.
2. **The change is a held "act" job**, created at proposal time, blocked, with the proposing job's placement (so host changes stay in the host group) and the call itself. The approval's subject names its job id. A decision releases it (`queued`) or cancels it; nothing can claim it before.
3. **The permit is bound to that job's own attempt.** `effects/permit` and `start` are answered only to the attempt of the act job whose id the approval names; the proposing attempt, another job's attempt, other arguments or a second ask get nothing. Single use, arguments digest and the launcher's invocation ledger are unchanged. The act attempt does the work, shapes the result through the pinned script, reports applied, absent or unknown with a receipt artifact.
4. **The Governor settles, not a runner.** One idempotent pass (`settleEffects`, after every decision, a chat denial, a revoke, a cancelled task, and every maintenance tick) settles each call: declined, expired (approval expiry is found here, since nobody polls), revoked, cancelled (the task is gone: approval revoked, act job cancelled), applied, absent or unknown. A restart in the middle only means the next pass finishes. When every call a job proposed is settled the job is queued again.
5. **The resumed attempt is told what happened** (outcome and what the change reported), is offered as a new pinned execution artifact, writes the final report and the evidence bundle. The bundle carries the effects, receipts and consumed approvals of the held jobs; the evidence checks accept permits of the proposing job's own attempts and of its held act jobs only.
6. **No loops.** Asking for the same tool with the same arguments again, in any attempt of the job, returns the first call's state and outcome and makes no second approval; a job may propose ten changes in all.
7. **Unknown is never retried.** A change of unknown outcome fails the task with a plain reason; its guard on the target stays until a person reconciles (an act job that dies after starting is an unknown outcome). An applied or absent receipt ends the guard.

## Limits
- The resumed attempt repeats the model work of the first (it starts from the task and the outcomes, not from a saved conversation).
- An approval still expires (1 to 1440 minutes, default 30); an overnight watch needs the window set accordingly.
- The permit's 15 second validity starts when the held job's attempt asks, not at approval.
