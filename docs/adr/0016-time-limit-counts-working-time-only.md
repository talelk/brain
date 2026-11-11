# 16. The time limit counts working time only

Date: 2026-11-11
Status: Accepted

Live bug (2026-11-11, real demo): a mission started from a starter Play paused for `budget` after 10-20 minutes. The local
model cost $0 and used few tokens. The cause was the 30 minute wall-clock limit of the Play: its clock started at mission
creation and ran while the mission waited for the person to confirm the plan, while plans were drafted, while work waited for
an approval and while the Governor was down for a deploy. The mission's own plan also estimated 1 h 25 min.

Decisions:

- **Working time** (`usage.activeMs`, the figure the time limit is checked against, shown as "active" and written into
  write-ups) is the union of the intervals in which at least one of the mission's attempts held its runner reservation: from the
  attempt's ledger row (`mission_spend.created_at_ms`) to the release of its capacity, or to now while it still runs. It is a
  union, not a sum, so two attempts in parallel count once. It is derived from the ledger, so nothing is stored per mission and
  nothing is backfilled; missions already paused for time get their true number.
- A person's waiting time (plan confirmation, approvals, parked work, a mission paused by a person), planning, queueing for a
  runner and Governor downtime with no attempt in flight count as zero. An attempt in flight across a Governor restart ends at
  the earlier of its release and its lease expiry, so recovery that releases it late does not bill the downtime.
- Challenge reviewer runs are charged to the mission's money and tokens (ADR 0012) but are not mission work: they are not
  working time. Coordinator runs are.
- The columns `missions.active_ms` and `active_since_ms` stay in the schema file only because the live-schema repair refuses to
  realign a table with columns the file does not declare; nothing reads or writes them.
- **The limit follows the plan.** `missions.budget_wall_explicit` (DEFAULT 0) is set when a person names a time limit (a budget at
  creation, or `mission.budget.set`). When a plan version is confirmed and the mission has a time limit that was not named by a
  person, the limit becomes `max(current default, estimate x 3, 2 h)` where the estimate is the sum of the declared task
  minutes. It only ever rises. A mission with no time limit stays without one; a limit named by a person is never changed by
  Brain, and the plan view warns before confirming when it is below the estimate (`plans.estimate.belowEstimate`).
- **One automatic extension.** When only the time limit is reached (money, tokens and the workspace cap have room), the
  mission's autonomy is `standard`, and the workspace has exactly one human member, admission extends the time limit once by 50%
  and records it (`missions.wall_extended`, DEFAULT 0, `mission.budgetChanged` with the note "Brain extended the time limit once").
  Money, tokens and caps are never raised by Brain. A person's later explicit change is a normal budget change.
- The time limit is not enforced on the coordinator, like money and tokens: a mission paused for time can still write its final checkpoint.
- A budget pause names which limit was reached (time, money, tokens, or the workspace cap) and the attention item offers
  "Add time/money and resume" presets; the click is a `mission.budget.set` of the full current budget plus the preset, followed by
  `mission.resume`, both audited with the person's name.

Rejected: a stored per-mission clock driven by state changes (it needs a hook at every start and stop and drifts when the
Governor restarts); counting only the sum of attempt times (parallel members would double-count).
