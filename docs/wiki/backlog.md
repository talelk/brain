# Backlog: open items only (lean on purpose)

Dated 2026-11-11 ~23:15, at `talelk/brain@9393922` (deployed: everything through track AF). History of every track, report and finding: [archive/](archive/) (excluded from the agent context budget; latest [archive/backlog-2026-11-11-night.md](archive/backlog-2026-11-11-night.md)). Keep THIS file short: when an item is done, delete its row and note it in the archive.

## Process rules learned
- Run at most 2 agents at once and cap vitest workers (`maxWorkers: 4`): uncapped parallel test runs OOM-killed the machine and restarted the session twice. After a restart check each agent's worktree: its commits survive; merge them yourself.
- Stop each agent, remove its worktree and `~/.cache/tmp-<name>`, and kill only its own wait-loops (by exact pid, never `pkill -f` patterns that can match your own shell) as soon as its report is taken. Avoid deploying while missions run (a deploy interrupts running attempts).
- Playwright "Executable doesn't exist" means the browser cache vanished: `npx playwright install chromium`; `pnpm build` before browser specs; run the specs for every UI/read-model change before deploying (agents often skip them).
- Deploy = `scripts/deploy-demo.sh` (pre-check on a VACUUM INTO snapshot pulled with rsync) then `scripts/stage-demo-release.sh` when `examples/v1` changed; new columns on existing tables need DEFAULT; retry a failed `git push` (github.com is sometimes unreachable).
- The demo browser session signs out after deploys; the assistant never types passwords into the hosted sign-in form: the owner signs in.

## Needs the owner
| Item | Why |
|------|-----|
| Sign in once in the Chrome tab | to run a real mission end to end through the renamed runtime (ADRs 0018-0020) and walk session-gated pages |
| Create one share link and open it signed out | creating a public link grants access: the assistant is blocked from doing it; verify `/shared/:token` is read-only |
| Decide the 4 quarantined tool proposals in Library | they need a person by design |
| Rotate the server sudo password | it was typed into chat several times |
| Optionally set `BRAIN_NOTIFY_SMTP_URL` / `BRAIN_NOTIFY_FROM` on the server | enables email notifications (off by default) |

## Open engine / quality rows
| # | Item | Notes |
|---|------|-------|
| 15 | Evaluator quality after track AG (qwen3.8-flash-next-a5b, 3 runs per sample): answers parsed 15/15, validator 15/15; one of six old-style review runs still sets a criterion met:false; plans valid first try 6/6 at a median 32 s (was 4/6 at 100 s). New prompts are in the repo, NOT yet staged live | run `scripts/stage-demo-release.sh` after the next deploy (agent instructions are bundle bytes, no digest re-pin needed); re-measure with `node scripts/qualification/task-quality.mjs --runs 3 --judge` and `--plans 6`; consider a faster planning model only if plan time regresses |
| 65 | Compaction and the new tools (documents.read, web.fetch, csv.query, knowledge.search) not yet exercised by real missions after the availability/size fixes | check Tools registry failure counts after the next missions |
| 66 | Email: STARTTLS/smtps only tested against a fake server; whole `startSupervisor` loop not run end to end (only `runClaimLoops`) | test against a real relay before relying on it |
| 67 | RTL: mixed English/Arabic bidi quirks need real Arabic strings; result-reader compare view not seen in RTL | needs translations |

## Not yet seen live
Needs-you "outcome unknown" row, Saved document in the Review inbox, scheduled Repeat occurrence (auto-confirm), notification preferences (email section), phone layout and install prompt on a real phone, the renamed runtime under a fresh mission.

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; reuse and capitalisation are first-class.
