# 6. Interrupted reasoning steps restart themselves

Date: 2026-11-11
Status: Accepted

A job whose runner disappeared (lease expired) or reported an unknown outcome used to stay
`outcome_unknown` until a person reconciled it, and never blind-requeued. That rule is right for
a job that may have started an external effect. It is wrong for an agent step or an evaluator
step that only reads: it holds no effect of its own, a second run is harmless, and waiting for a
person turned every deploy or runner restart into a stuck run.

An agent (`uses.type = agent`) or evaluator (`kind = eval`) job with effect class `read`, no
effect permit and no resource lease for the interrupted attempt is therefore concluded as an
interrupted attempt and queued again with `queue_reason = RESTARTED_AFTER_INTERRUPTION`. No run
failure is reported, so no failed attempt counts toward parking. Interruptions the platform caused (lease lost, unknown outcome) never use the budget of 5 restarts (safety cap 20 attempts); when it is spent the job is retried once after a cooldown, then the step fails as "interrupted N times; try again" and the task parks (track U).
Every other job keeps the original rule:
tools and anything with a permit or lease remain `outcome_unknown` until independent reconciliation.

Rejected: restarting every `read` job (tool steps can still depend on a target we cannot read back),
and counting interruptions as failed attempts (a deploy would park healthy work).
