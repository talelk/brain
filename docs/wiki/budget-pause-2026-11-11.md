# Budget pause on a free model (track R, 2026-11-11)

Live finding, real demo ~11:45: a mission from the starter Play "Write a checklist or runbook" paused with `pause_reason=budget` after 10-20 minutes although the local model costs $0 (41k in / 13k out). Its row had `budget_wall_ms=1800000`, `member_cap=2`, `budget_micro_usd=2000000`, while its own plan said "about 1 h 25 min across 6 tasks".

Causes (read from `apps/governor/src/modules/missions/budget.ts` before the fix):
1. The Play's 30 minute limit was shorter than the plan's own estimate: a guaranteed pause.
2. The clock started at mission creation (`active_since_ms` set by the INSERT) and ran while the mission waited for plan confirmation, for approvals and while the Governor was down for a deploy.
3. The Needs-you item only had an "Open" button and did not say which limit was reached (backlog 36).
4. The time limit was also applied to the coordinator, so a time pause could never write its final checkpoint; `hasHeadroom` compared money to the whole budget while admission used budget minus the final allowance, so a resume could pass and re-pause at once; the mission limits dialog had no time field, so nobody could raise a time limit from the UI.

Fixes (ADR 0016): working time is the union of attempt intervals from the usage ledger (no stored clock); a default limit rises at plan confirmation to max(default, estimate x 3, 2 h) and a limit a person named never changes (the plan view warns when it is below the estimate); one automatic +50% extension when only time ran out on a one-person install with standard autonomy; the Needs-you item names the limit and offers +30 min / +2 h / +$1 / +$5 / +200k tokens and resume in one click, recorded as "Limits changed: ..." with the person's id; the limits dialog has a time field; starter Plays now carry 2 h (research 4 h) and member cap 3.

Not changed: the workspace spend cap is still raised from the mission or Usage page (the Today item only links there); an attempt in `outcome_unknown` still holds a member slot until a person resolves it (backlog 54). Existing missions already paused for time resume with one click because their working time is recomputed from the ledger.
