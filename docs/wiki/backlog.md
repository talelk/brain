# Backlog: open items only (lean on purpose)

Dated 2026-11-11 ~15:45, at `talelk/brain@bd16582`+ (deployed: waves 1-3, tracks K M N P Q R S T U V W X). History of every track and report: [archive/backlog-2026-11-11.md](archive/backlog-2026-11-11.md) and [archive/backlog-2026-11-11-evening.md](archive/backlog-2026-11-11-evening.md) (excluded from the agent context budget). Keep THIS file short: when an item is done, delete its row and note it in the archive/history pages.

## Process rules learned
- Run at most 2 agents at once and cap vitest workers (`maxWorkers: 4`): uncapped parallel test runs OOM-killed the machine and restarted the session twice on 2026-11-11. After a restart check the agents' worktrees: their commits survive; merge them yourself.
- Stop each agent and remove its worktree + `~/.cache/tmp-<name>` as soon as its report is taken. Avoid deploying while missions run (each deploy interrupts running attempts).
- If Playwright says "Executable doesn't exist", the browser cache vanished (session restart): `npx playwright install chromium` (about 120 MB), then rerun. Run the browser specs for every UI/read-model change before deploying: agents often skip them.
- Deploy = `scripts/deploy-demo.sh` (pre-check on a VACUUM INTO snapshot pulled with rsync) then `scripts/stage-demo-release.sh` when `examples/v1` changed; new columns on existing tables need DEFAULT.

## Open product work (GitHub issues, `talelk/brain`)
| Issue | Item | Notes |
|-------|------|-------|
| #69, #65, #46 | Parent/umbrella issues: #77 is done (interactive runs are metered); close these after review | |
| #3, #4, #5 | Domain vocabulary: Run aggregate type, WorkflowJob naming, WorkflowState vs WorkflowRunState | needs-triage, docs/ADR + contract rename |

## Open UI / quality rows
| # | Item | Notes |
|---|------|-------|
| 32 | "Reading N sources" doing-now sentence missing on session rail / Plan rows | needs transcript |
| 35 | Trust read lacks per-criterion evidence link and mission-level aggregate | |
| 38 | Run all new specs at 390-dark / 768 / RTL (only 1440-light, 390-dark, 768-light fully covered) | QA |

## Open engine / quality rows
| # | Item | Notes |
|---|------|-------|
| 15 | Evaluator proves criteria were answered, not that answers are correct; real-model quality 10/12 first-try pass (`scripts/qualification/task-quality.mjs`, plans via `--plans N`) | measure/improve; consider a model-judged independent check |
| 33 | `first-launch` and a few integration tests time out under heavy load | mitigated by `maxWorkers: 4` and the timing factor; re-check |
| 64 | Multi-slot runner loop untested with >1 concurrent attempts; session refresh (13 min) briefly lowers concurrency for very long attempts; Health/Runners show "busy" without slots | T leftover |
| 65 | Compaction and the new tools (documents.read, web.fetch, csv.query, knowledge.search) untested with a real model; web.fetch egress works live; its failures were the 64 KiB script-input cap (fixed, needs runner redeploy) and off-list hosts (hosts now in the pack); see web-fetch-and-tool-availability-2026-11-11.md | I4 leftover |
| 66 | Email transport for notifications is not built (in-app + push + signed webhook only) | G3 decision (ADR 0010-0015) |

## Deployed 2026-11-11 ~16:40 (tracks Y, Z; `297a40e`)
Live confirmed: install card on Today; workspace usage panel with "Outside missions". Z found and fixed a real security bug (a share link kept working after its creator was disabled or downgraded below `mission:write`). Z added: outcome-unknown tool steps in Needs you ("Treat as failed" / "Try again" for read steps only), "Restarting" state, saved documents in the Review inbox, `workspace_spend` bucket.
Not seen live yet: Needs-you outcome-unknown row, Saved document in Review inbox, phone layout on a real phone, install prompt on a real phone.

## Live walkthrough 2026-11-11 ~16:50 (deployed `bd57d39`)
Confirmed: Quality page live with real numbers (97% verified without human help 32/33, stall rate 3%, re-open 12.5%, definitions shown); Tools registry live with per-tool calls/failures and agents allowed; workspace usage panel "Outside missions".
| # | Item | Notes |
|---|------|-------|
| 67 | Tools wasted on failing calls: `documents.read` 21/21 failed (workspace has 0 documents), `web.fetch` 50/66 failed (egress/allowlist?), `csv.query` never used; registry detail shows "Preview unavailable: artifact not found" for tool script evidence | track AA running: availability logic, honest registry, fix or hide web.fetch |

## Deployed 2026-11-11 ~17:50 (tracks AA, AB + my follow-up, `41fd905`)
Live: Library shows "Awaiting your review: 4" (tool proposals only) and "Published automatically: 5". The 10 "waiting write-ups" were old mission notes with no mission and no title (AB could not reproduce my guessed cause: Governor-closed missions already auto-publish); the sweep now sets such notes aside with a reason. AA: web.fetch failures were 33 "tool input too large" + 17 host not on allowlist (egress is fine); runner reduces HTML to <48 KiB, unavailable tools are dropped from the tool list with reasons, registry shows failure rates. Check next mission: Tools registry failure counts should stop growing.
Open: 4 quarantined tool proposals in Library need a person (decide: review UI wording); `git push` failed once with "Could not resolve host: github.com" (network hiccup, retry works).

## Not yet walked live
Context received tab, Share link page (`/shared/:token`), Library Plays shelf after "Add starter Plays", scheduled Repeat occurrence (auto-confirm), Notification preferences (Security).

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; reuse and capitalisation are first-class.
