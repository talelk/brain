# Backlog: open items only (lean on purpose)

Dated 2026-11-11, at `talelk/brain@e38aa19`. The full history of every track, report and finding is in [archive/backlog-2026-11-11.md](archive/backlog-2026-11-11.md) (excluded from the agent context budget: read it only when you need the history). Keep THIS file short: when an item is done, delete the row here and note it in the archive/history pages, never the other way round.

## In progress
- Track M (UI editor), rows 47-50 done locally (not deployed): auto-published self-reviewed write-ups (setting `library_settings`, Approve all verified, Today line), substantive write-ups with a 200-character threshold and supersede, six starter Plays with `plays.addStarter` (live has none: restage or click "Add starter Plays"), Library tab strip, one-segment bars, 24-hour times. Still open from M: Health "Recent activity" plain sentences (`payload.message` of `tool.read.refused`); Setup stepper third circle shows "3" not a tick; row 53. Deploy note: schema adds two DEFAULT columns on `knowledge_assets` and the table `library_settings`; the first sweep rebuilds and publishes the 19 thin unreviewed write-ups (Withdraw undoes one).

- Track R (time limit counts working time, ADR 0016; row 36 done): local, not deployed. Schema adds two DEFAULT columns on `missions` (`budget_wall_explicit`, `wall_extended`). Starter Plays changed (2 h, research 4 h, member cap 3): restage the starter release, then add Plays again or recreate them; missions already paused for time resume with one click on Today.

## Open
| # | Item | Notes |
|---|------|-------|
| 15 | Evaluator proves criteria were answered, not that answers are correct; real-model quality 10/12 pass in `scripts/qualification/task-quality.mjs` | measure/improve; consider a model-judged independent check |
| 26 | #77 meter: interactive runs outside missions are not in the usage ledger | |
| 27 | Sidebar highlights Live on /runners; Passkeys paragraph jargon | UI |
| 32 | "Reading N sources" doing-now sentence missing on session rail / Plan rows | needs transcript |
| 33 | `first-launch` and a few integration tests still time out under heavy machine load | pass alone; E2 timing factor helps |
| 35 | Trust read lacks per-criterion evidence link and mission-level aggregate | |
| 38 | Run all new specs at 390-dark / 768 / RTL (only 1440-light, 390-dark, 768-light fully covered) | QA |
| 40 | Share page is text only (no Markdown rendering/branding) | |
| 53 | UI for track K: send `sourceMissionId` from `RepeatSheet`; link schedule history `dispatchRef` starting `mission-` to the mission page; mission Outputs tab shows recorded named outputs under "Documents with versions" next to Result cards: hide or merge | UI |
| 54 | Notification-throttle behaviour across restart and share-token expiry races not examined (K item 7); a read job interrupted 5 times keeps its reservation until a person resolves it (by design) | adversarial tests |
| 55 | Saved documents are searchable but not queued for Review; result-ready announcement not extended to the inbox | I3 leftover |

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

## Track S deployed (2026-11-11 ~12:40, `cd1862f`)
Root cause of the stuck run: the runner listed the same artifact id three times in its evidence bundle (identical tool results share a content-derived id); the Governor rejected it as non-retryable ("duplicate artifact identity"); job stayed `verifying` with the evaluator step pending and nothing swept it. Fixed both ends + `sweepStuckJobs` watchdog (default 15 min, `BRAIN_STUCK_JOB_MINUTES`; requeues read-only agent/evaluator jobs, fails with a plain reason when restarts are used up; idempotent; emits `job.updated` with reason). Live confirmation: after deploy the stuck job was restarted (mission tokens 9.6k -> 44k) and the mission then paused on its 30-minute wall budget: that is track R's bug (wall clock must be active time). Tests: `stuck-run-watchdog.test.ts`, chaos `stuck-run-restart.test.ts`.
Housekeeping 2026-11-11 ~12:00: stopped lingering agents (A2 9 h, E), removed 25 stale worktrees and ~16 temp dirs, killed a leaked ssh-agent. Rule: stop each agent and remove its worktree/tmp as soon as its report is taken.

## Track R deployed (2026-11-11 ~12:45, `3eae7f9` + revert of my permission gate) and live findings
- R: time limit counts working time only (ADR 0016), plan-aware defaults (max(current, 3x estimate, 2 h)), "This plan stops at $2 or 2 h of working time", Needs-you budget pause names the limit and offers Add 30 min / 2 h / $1 / $5 / 200k tokens + resume (or plain Resume when headroom exists), one-time 50% extension for single-owner installs, limits dialog has a time field; starter Plays 2-4 h, cap 3. Live: both paused missions showed plain **Resume** (headroom recomputed) and the on-call mission continued. Release restaged; live Plays are release documents (re-click "Add starter Plays" for new defaults).
- My own regression, fixed: gating the Library auto-publish switch on `identity.actor.scopes` disabled it for the workspace lead on the live site (browser identity has no workspace scopes). Reverted to `canAdminister()` (`LibraryControls.tsx`); spec `hands-off-library` passes again.
- Track T (done locally, not deployed): readiness separates capability from capacity (busy runner = ready with `busy` field), Today shows a calm queue note and never blocks for it, runners run N concurrent sessions (`BRAIN_RUNNER_SLOTS`; demo 3 agents / 2 evaluators, applied to the unit env on each deploy). See ops-live-server.md.

## Track T deployed and confirmed live (2026-11-11 ~13:05, `0a16184`)
Readiness separates capability from capacity (busy runner = ready, `busy: {slotsInUse, slotsTotal}`); Today box never blocked by a busy runner ("Brain is working on N things; yours queues and starts next"); runner supervisor runs one claim loop per slot (`BRAIN_RUNNER_SLOTS`), deploy sets agents 3 / evaluators 2 slots in `runner-*.env` on every deploy. Live: runner rows show slot_capacity 3 and 2, healthy; Today unblocked; the 6-task on-call mission finished "closed - achieved" after the R/S/T fixes; note-taking mission resumed with limit "$2 or 5 h of working time".
Leftovers (T): multi-worker supervisor loop untested with >1 concurrent attempts; session refresh (13 min) briefly lowers concurrency for very long attempts; busy-runner spec only at 1440-light; Health/Runners UI still says "busy".

## Track U (2026-11-11, local, not deployed): interrupted reasoning jobs
Confirmed live: job `job-mwbxl67a-1o-6bfqmakh` (run `run-mwbxl678-1n-zo5903gh`) was `outcome_unknown` with attempt 5 `outcome_unknown` (lease expired ~13:00 local, the deploys), `attempt_counter` 5, and no event for a person while the UI said "running". Fix: attempts ended by lease loss or an unknown outcome are tagged `interruption='platform'` and do not use the 5-restart budget (safety cap 20 attempts); a read-only job with no budget left waits `BRAIN_PARKED_COOLDOWN_SECONDS` (60), is retried once (`jobs.auto_retries`), then the step fails with `AGENT_INTERRUPTED` ("The agent was interrupted N times; try again.") and the task parks at once with blocked reason "Stopped: waiting for you to try again" (Needs you + task: Try again). Two new DEFAULT columns on control tables (`jobs.auto_retries`, `job_attempts.interruption`); no restage. Effectful jobs left `outcome_unknown` are still not surfaced in Needs you (open). Avoid deploying while missions run unless needed.

## Track U deployed (2026-11-11 ~14:00, `99915aa`)
Evidence (live, read-only): job `job-mwbxl67a-1o-6bfqmakh` attempts 1-4 failed, watchdog restarted it after 98 min, attempt 5 lost its lease at the deploy and became `outcome_unknown` with attempt_counter 5, so `expireLeases` could not restart it and nothing surfaced it. Fixes: platform interruptions (`job_attempts.interruption='platform'`) never use the 5-restart budget (cap 20); a read-only job with no budget left waits `BRAIN_PARKED_COOLDOWN_SECONDS` (60) then retries once (`jobs.auto_retries`), then fails with `AGENT_INTERRUPTED` and the task parks "Stopped: waiting for you to try again" with a Needs-you Try again; UI no longer says "running" for a stopped task. Live confirmation: after deploy the sweep queued a new attempt for the stuck job (mission tokens 44k -> 46k).
Open: effectful (tool) jobs left `outcome_unknown` still do not appear in Needs you; between an interruption and the end of the cooldown (~1 min) the UI still says "running".

## Not yet walked live (blocked on deploy of K and M)
Share links, Challenge this result, Repeat this (now creates real missions), Context received tab, Tools registry, Quality page, Usage meter in depth.

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; new columns on existing tables need DEFAULT; deploy through scripts/deploy-demo.sh then scripts/stage-demo-release.sh when `examples/v1` changed.
