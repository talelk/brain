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
| Re-allow the Claude extension on brain.mykeyrus.tn (chrome://extensions) and sign in once in the Chrome tab | to run a real mission end to end through the renamed runtime (ADRs 0018-0020) and walk session-gated pages |
| Create one share link and open it signed out | creating a public link grants access: the assistant is blocked from doing it; verify `/shared/:token` is read-only |
| Decide the 4 quarantined tool proposals in Library | they need a person by design |
| Rotate the server sudo password | it was typed into chat several times |
| Optionally set `BRAIN_NOTIFY_SMTP_URL` / `BRAIN_NOTIFY_FROM` on the server | enables email notifications (off by default) |

## Open engine / quality rows
| # | Item | Notes |
|---|------|-------|
| 15 | Evaluator quality after track AG (qwen3.8-flash-next-a5b, 3 runs per sample): answers parsed 15/15, validator 15/15; one of six old-style review runs still sets a criterion met:false; plans valid first try 6/6 at a median 32 s (was 4/6 at 100 s). New prompts are in the repo, NOT yet staged live | run `scripts/stage-demo-release.sh` after the next deploy (agent instructions are bundle bytes, no digest re-pin needed); re-measure with `node scripts/qualification/task-quality.mjs --runs 3 --judge` and `--plans 6`; consider a faster planning model only if plan time regresses |
| 66 | Email: STARTTLS/smtps only tested against a fake server; whole `startSupervisor` loop not run end to end (only `runClaimLoops`) | test against a real relay before relying on it |
| 67 | RTL: mixed English/Arabic bidi quirks need real Arabic strings; result-reader compare view not seen in RTL | needs translations |

## Deployed 2026-11-12 ~00:30 (track AG, `e8ee242`, release restaged)
Prompts: task-worker criteria semantics (`met` is about the deliverable; reviews still set `met:true` for "the review states..." criteria; criteria verbatim, one row each) and a shorter plan-guide. Measured on `qwen3.8-flash-next-a5b` (3 runs per sample): answers parsed 15/15 and validator 15/15 after (one later re-check had a `criteria-met` failure on an old-style sample); judge agreement on old-style samples 100% in 5 of 6 runs once the judge got the same semantics (so read that number with care); plan drafts over 6: first-try valid 4/6 -> 6/6, median 100 s -> 32 s, max 253 s -> 87 s. Flaky tests: root cause of the `golden` failure under load was a pooled socket closed by Node's 5 s idle timeout (`keepAliveTimeout=120s` + `closeAllConnections()`); all explicit test timeouts now go through `scaled()` (load-aware, `BRAIN_TEST_TIMEOUT_FACTOR` overrides); 14x CPU load: before 1 of 2 runs failed, after 2 of 2 passed (531/531). Row 33 closed.
Browser: the Chrome extension lost site access to brain.mykeyrus.tn (tab group changed; "Chrome blocked the extension from accessing this page"): the owner needs to re-allow it in chrome://extensions and sign in.

Tools: all four read tools exercised by real live missions 2026-11-12 (knowledge.search, web.fetch on an allowed host, documents.read + csv.query on two sample files uploaded to the demo workspace; each mission closed achieved). Row 65 closed.

Dependabot: 3 moderate transitive advisories pinned in `pnpm-workspace.yaml` overrides 2026-11-12 (`72168f6`); `pnpm audit --prod` clean. One dev-only advisory remains (minimatch under `eslint-plugin-import-x`, which needs minimatch 10's `makeRe`; 11 breaks lint): wait for an import-x release.

## Not yet seen live
Needs-you "outcome unknown" row, Saved document in the Review inbox, scheduled Repeat occurrence (auto-confirm), notification preferences (email section), phone layout and install prompt on a real phone.

Seen live 2026-11-12 (API-driven, no browser): fresh plain-words mission on the deployed build (renamed runtime + tightened prompts): plan drafted in 25 s (2 tasks), confirmed, both tasks done, mission closed/achieved at 146 s with no manual step. Still needs a browser look when the owner re-allows the extension.

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; reuse and capitalisation are first-class.
