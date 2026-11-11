# Backlog: open items only (lean on purpose)

Dated 2026-11-11, at `talelk/brain@e38aa19`. The full history of every track, report and finding is in [archive/backlog-2026-11-11.md](archive/backlog-2026-11-11.md) (excluded from the agent context budget: read it only when you need the history). Keep THIS file short: when an item is done, delete the row here and note it in the archive/history pages, never the other way round.

## In progress
- Track M (UI editor), rows 47-50 done locally (not deployed): auto-published self-reviewed write-ups (setting `library_settings`, Approve all verified, Today line), substantive write-ups with a 200-character threshold and supersede, six starter Plays with `plays.addStarter` (live has none: restage or click "Add starter Plays"), Library tab strip, one-segment bars, 24-hour times. Still open from M: Health "Recent activity" plain sentences (`payload.message` of `tool.read.refused`); Setup stepper third circle shows "3" not a tick; row 53. Deploy note: schema adds two DEFAULT columns on `knowledge_assets` and the table `library_settings`; the first sweep rebuilds and publishes the 19 thin unreviewed write-ups (Withdraw undoes one).

## Open
| # | Item | Notes |
|---|------|-------|
| 15 | Evaluator proves criteria were answered, not that answers are correct; real-model quality 10/12 pass in `scripts/qualification/task-quality.mjs` | measure/improve; consider a model-judged independent check |
| 26 | #77 meter: interactive runs outside missions are not in the usage ledger | |
| 27 | Sidebar highlights Live on /runners; Passkeys paragraph jargon | UI |
| 32 | "Reading N sources" doing-now sentence missing on session rail / Plan rows | needs transcript |
| 33 | `first-launch` and a few integration tests still time out under heavy machine load | pass alone; E2 timing factor helps |
| 35 | Trust read lacks per-criterion evidence link and mission-level aggregate | |
| 36 | Budget-pause and routed attention items open their page instead of acting inline | |
| 38 | Run all new specs at 390-dark / 768 / RTL (only 1440-light, 390-dark, 768-light fully covered) | QA |
| 40 | Share page is text only (no Markdown rendering/branding) | |
| 53 | UI for track K: send `sourceMissionId` from `RepeatSheet`; link schedule history `dispatchRef` starting `mission-` to the mission page; mission Outputs tab shows recorded named outputs under "Documents with versions" next to Result cards: hide or merge | UI |
| 54 | Notification-throttle behaviour across restart and share-token expiry races not examined (K item 7); a read job interrupted 5 times keeps its reservation until a person resolves it (by design) | adversarial tests |
| 55 | Saved documents are searchable but not queued for Review; result-ready announcement not extended to the inbox | I3 leftover |

## Found live 2026-11-11 ~09:15 (track K deployed, `bd16582`)
- Token meter is empty: `mission_spend` has 59 rows, all with 0 input/output tokens, `estimated=0`; closed mission shows "No usage recorded yet". Agents emit usage; it does not reach the ledger. Track N is tracing it (Pi engine -> attempt usage -> settlement) and will add estimated counts when an endpoint reports none.
- Tool refusals on live (Health "tool read refused") confirmed as `documents.read` calls with an unknown document id / missing context reference (model guessing ids), not a broker bug; K's fix makes refusals explain themselves.
- Repo token budget check tripped (141k/140k): history moved to `docs/wiki/archive/` (excluded from the budget); keep this file lean.

## Found live 2026-11-11 ~10:50 (tracks M, N deployed; release `sha256:d2401bce…` active)
Confirmed good: six starter Plays as chips on Today; "Brain learned 2 things this week (2 on its own)"; Play flow text "Add a sentence to change the goal, or just start".
- Track P (running): Play + sentence loses the Play name in the mission title; the reuse panel now blocks auto-drafting with a manual "Draft the plan with these 3" step and suggests irrelevant items (a support-reply Play for a note-taking comparison).
- CONFIRMED LIVE ~10:58: token meter works after track N (`8e426f3`): Usage block shows "8.1k tokens, $0 (local models report no cost), 4.5k in / 1.0k out / 6 cached" on a running Play mission; two tasks ran in parallel; Play limit shown ("$2 or 30 min of active time"). Old zero rows stay zero by design (no historical backfill).
- Plan drafting for the Play mission took over 90 s (plan-guide now has knowledge.search): watch planning latency and the one-retry path; if it fails, check `planning_requests`.
- Pre-deploy check hardened twice (VACUUM INTO snapshot, gzip, one retry); first deploy with it passed. `scripts/snapshot-live-dbs.mjs` runs inside the container.

## Track P confirmed live (2026-11-11 ~11:20, deployed `a91ff24`)
Play + sentence now titles the mission "Write a checklist or runbook: <topic>"; plan drafts as soon as the page opens (no panel, no manual button); "Used from past work: N items (change)" line replaces the blocking panel; relevance cutoff excludes Plays and unrelated items. Verified by clicking through the live site. Hygiene: 24 stale agent worktrees (all merged into main) removed; no Brain processes running; `ListAgents` shows no running subagents.

## 2026-11-11 ~11:35 live check
Confirmed: Play+sentence mission drafted its plan with zero clicks ("6 steps - nothing runs until you confirm" + Confirm), confirm -> task running; "Used from past work" line replaces blocking panel. Plan showed "revision 2" and took ~2 min for the second mission in a row: first attempt likely fails and the auto-retry rescues it. Track Q (running) measures failure rate/latency from live data and fixes causes (tool turns, validator feedback in retry, prompt-side reuse context).

## Found live 2026-11-11 ~11:50 (deployed `409e4bc`, release restaged)
- Track Q (done, `409e4bc`): plan failures are rare (2/10, both pre-knowledge.search: human assignment missing `id`); "revision 2" is NOT a retry (rev 1 = Play template draft); latency 64-71 s came from the extra knowledge.search tool turn; now one model session with `related` hits in the prompt (expected ~20-35 s), runner corrective retry also for schema violations, `MissionPlanView.stage` (reading/drafting/checking) read field added (UI not yet showing it). Notes: `docs/wiki/plan-latency-2026-11-11.md`.
- Track R (running): Play default wall-clock limit (30 min) is below the plan's own estimate (1 h 25 min) so a Play mission paused "budget exhausted" after ~10-20 min; wall clock must be ACTIVE running time; plan-aware default limit; inline "Add time and resume" on the Needs-you budget pause; auto-extend time once on a single-owner install.
- Track S (running): run `run-mwbxl678-1n-zo5903gh` of mission `mission-mwbxiijh-d-otaijyxj` stuck "running" ~80 min after deploy restarts; A2's crash-restart did not recover it; add stuck-run watchdog + fix root cause; mission also exceeds its wall budget yet stays active.
- UI to follow: show plan `stage` ("Reading what the workspace knows / Drafting steps / Checking the plan") while "Preparing a validated proposal".

## Not yet walked live (blocked on deploy of K and M)
Share links, Challenge this result, Repeat this (now creates real missions), Context received tab, Tools registry, Quality page, Usage meter in depth.

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; new columns on existing tables need DEFAULT; deploy through scripts/deploy-demo.sh then scripts/stage-demo-release.sh when `examples/v1` changed.
