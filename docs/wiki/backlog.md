# Backlog: open items only (lean on purpose)

Dated 2026-11-11 ~15:45, at `talelk/brain@bd16582`+ (deployed: waves 1-3, tracks K M N P Q R S T U V W X). History of every track and report: [archive/backlog-2026-11-11.md](archive/backlog-2026-11-11.md) and [archive/backlog-2026-11-11-evening.md](archive/backlog-2026-11-11-evening.md) (excluded from the agent context budget). Keep THIS file short: when an item is done, delete its row and note it in the archive/history pages.

## Process rules learned
- Run at most 2 agents at once and cap vitest workers (`maxWorkers: 4`): uncapped parallel test runs OOM-killed the machine and restarted the session twice on 2026-11-11. After a restart check the agents' worktrees: their commits survive; merge them yourself.
- Stop each agent and remove its worktree + `~/.cache/tmp-<name>` as soon as its report is taken. Avoid deploying while missions run (each deploy interrupts running attempts).
- Deploy = `scripts/deploy-demo.sh` (pre-check on a VACUUM INTO snapshot pulled with rsync) then `scripts/stage-demo-release.sh` when `examples/v1` changed; new columns on existing tables need DEFAULT.

## Open product work (GitHub issues, `talelk/brain`)
| Issue | Item | Notes |
|-------|------|-------|
| #77 | Token and cost meter: remaining gap = interactive runs outside missions are not in the usage ledger (row 26) | meter itself works live |
| #69, #65, #46 | Parent/umbrella issues: close once #77 is done | |
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
| 54 | Notification-throttle across restart and share-token expiry races not examined; a read job interrupted 20 times keeps its reservation until a person resolves it | adversarial tests |
| 55 | Saved documents are searchable but not queued for Review; result-ready announcement not extended to the inbox | I3 leftover |
| 63 | Effectful (tool) jobs left `outcome_unknown` do not appear in Needs you; UI says "running" for ~1 min between interruption and cooldown retry | U leftover |
| 64 | Multi-slot runner loop untested with >1 concurrent attempts; session refresh (13 min) briefly lowers concurrency for very long attempts; Health/Runners show "busy" without slots | T leftover |
| 65 | Compaction and the new tools (documents.read, web.fetch, csv.query, knowledge.search) untested with a real model; web.fetch needs outbound access from the runner host; handoff summaries may appear twice in a prompt | I4 leftover |
| 66 | Email transport for notifications is not built (in-app + push + signed webhook only) | G3 decision (ADR 0010-0015) |

## Not yet walked live
Context received tab, Tools registry, Quality page, Share link page (`/shared/:token`), Library Plays shelf after "Add starter Plays", scheduled Repeat occurrence (auto-confirm), Notification preferences (Security).

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; reuse and capitalisation are first-class.
