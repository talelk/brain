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
| 54 | Notification-throttle behaviour across restart and share-token expiry races not examined (K item 7); a read job interrupted 5 times keeps its reservation until a person resolves it (by design) | adversarial tests |
| 55 | Saved documents are searchable but not queued for Review; result-ready announcement not extended to the inbox | I3 leftover |

## Track U deployed (2026-11-11 ~14:00, `99915aa`)
Evidence (live, read-only): job `job-mwbxl67a-1o-6bfqmakh` attempts 1-4 failed, watchdog restarted it after 98 min, attempt 5 lost its lease at the deploy and became `outcome_unknown` with attempt_counter 5, so `expireLeases` could not restart it and nothing surfaced it. Fixes: platform interruptions (`job_attempts.interruption='platform'`) never use the 5-restart budget (cap 20); a read-only job with no budget left waits `BRAIN_PARKED_COOLDOWN_SECONDS` (60) then retries once (`jobs.auto_retries`), then fails with `AGENT_INTERRUPTED` and the task parks "Stopped: waiting for you to try again" with a Needs-you Try again; UI no longer says "running" for a stopped task. Live confirmation: after deploy the sweep queued a new attempt for the stuck job (mission tokens 44k -> 46k).
Open: effectful (tool) jobs left `outcome_unknown` still do not appear in Needs you; between an interruption and the end of the cooldown (~1 min) the UI still says "running".

## Live walkthrough 2026-11-11 ~14:10 (finished note-taking mission, deployed `99915aa`)
Confirmed: mission finished 6/6 (204k tokens, $0) after stuck/pause/resume (S, R, T, U fixes); deliverable excellent (recommendation, scored criteria, runner-up, caveats; Markdown rendered); "Author's own checklist 3 of 3 met" with evidence; "Challenge this result" works live (state running); "Propose as Play" and "What Brain reused" present; Repeat this button on the closed mission.
Track V (done locally, not deployed): root cause of "Not independently checked yet": an agent job uploads its raw reply as text/plain and pins only the normalised JSON output in its evidence bundle; the two digests differ when a model indents its JSON, so `artifacts.history` (digest match only) found no verdict for the Result artifact. `artifactHistory` now also matches the bundle of the attempt that wrote the artifact. Result cards keep their open state and scroll across refreshes (keyed by task id, `?result=`, no skeleton on refresh); named-output versions are a "Version history" inside each card (row 53 closed); share link and challenge result appear on the mission card (challenge also when collapsed).

## Not yet walked live (blocked on deploy of K and M)
Share links, Challenge this result, Repeat this (now creates real missions), Context received tab, Tools registry, Quality page, Usage meter in depth.

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; new columns on existing tables need DEFAULT; deploy through scripts/deploy-demo.sh then scripts/stage-demo-release.sh when `examples/v1` changed.
