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
| Connect a Git repo (Administration > This workspace > Integrations: connection with a token, then a configuration write binding) | Edit this tool (deployed 2026-11-12) validates anywhere but can only publish through that binding; the live server has none |
| Tool self-test: run a tool's own `test.sh` in the sandbox (stage it, add a runner mode) and show the result | Try this tool (run with my input) is deployed; the self-test needs `test.sh` staged, which nothing does yet |
| Capability-gap auto-heal: when a task fails because its agent lacks a tool it needs, switch it to a recipe whose agent has it (needs plan tasks to declare required tools, or a per-workspace default recipe) | 2026-11-12: the docker inspection task failed 3x on general-task (no host.exec); sre-task is `system`, so the planner never picks it. Run this task with (deployed) is the manual fix |
| Plan / Live / Outputs / admin review: 43 fixes and enhancements (reviewer verdict names an internal id, parked task has no reason or history, reload on /settings or /approvals switches workspace, Outputs shows technical files first and looks capped at 100) | full list in `docs/wiki/archive/review-plan-live-outputs-2026-11-12.md`; the end-to-end mission flow was not walked |
| Create one share link and open it signed out | creating a public link grants access: the assistant is blocked from doing it; verify `/shared/:token` is read-only |
| Decide the quarantined tool proposals in Library (demo workspace: 5; sre-demos: 1 tool + 1 Play proposal "Keep the demos server healthy", filed 2026-11-12) | they need a person by design; approving the Play opens a Studio draft |
| Rotate the server sudo password | it was typed into chat several times |
| Optionally set `BRAIN_NOTIFY_SMTP_URL` / `BRAIN_NOTIFY_FROM` on the server | enables email notifications (off by default) |

## Open engine / quality rows
| # | Item | Notes |
|---|------|-------|
| 15 | Evaluator quality re-measured 2026-11-12 on the deployed prompts (qwen3.8-flash-next-a5b, 3 runs per sample): parsed 14/15, validator 14/15; both old-style review samples passed 3/3 (the earlier weak spot did not recur). The one failure was a review-with-upstream answer with malformed JSON (unparsed), a random model flake, not criteria semantics | watch the live retry behaviour on unparsed answers; consider a stricter JSON instruction only if flakes recur |
| 66 | Email: STARTTLS/smtps only tested against a fake server; whole `startSupervisor` loop not run end to end (only `runClaimLoops`) | test against a real relay before relying on it |
| 67 | RTL checked live 2026-11-12: layout mirrors correctly (sidebar right, arrows flipped, buttons at the start edge) and mixed Arabic/English text reads correctly. Remaining quirk: English UI strings in RTL put trailing punctuation on the left; do not patch with bidi CSS, it goes away with Arabic translations. Compare view in RTL still unseen | needs Arabic translations of the UI copy (no message catalog exists yet) |
| 68 | SRE host access (ADR 0021) ships read-only: `host.read` and `host.exec`. Missing: privileged commands (restart/reload, effect permit per call), a writable per-run output directory, a dedicated runner group so host tools exist only for the SRE workspace | when the owner wants host changes |

## Deployed 2026-11-12 ~00:30 (track AG, `e8ee242`, release restaged)
Prompts: task-worker criteria semantics (`met` is about the deliverable; reviews still set `met:true` for "the review states..." criteria; criteria verbatim, one row each) and a shorter plan-guide. Measured on `qwen3.8-flash-next-a5b` (3 runs per sample): answers parsed 15/15 and validator 15/15 after (one later re-check had a `criteria-met` failure on an old-style sample); judge agreement on old-style samples 100% in 5 of 6 runs once the judge got the same semantics (so read that number with care); plan drafts over 6: first-try valid 4/6 -> 6/6, median 100 s -> 32 s, max 253 s -> 87 s. Flaky tests: root cause of the `golden` failure under load was a pooled socket closed by Node's 5 s idle timeout (`keepAliveTimeout=120s` + `closeAllConnections()`); all explicit test timeouts now go through `scaled()` (load-aware, `BRAIN_TEST_TIMEOUT_FACTOR` overrides); 14x CPU load: before 1 of 2 runs failed, after 2 of 2 passed (531/531). Row 33 closed.
Browser: the Chrome extension lost site access to brain.mykeyrus.tn (tab group changed; "Chrome blocked the extension from accessing this page"): the owner needs to re-allow it in chrome://extensions and sign in.

Tools: all four read tools exercised by real live missions 2026-11-12 (knowledge.search, web.fetch on an allowed host, documents.read + csv.query on two sample files uploaded to the demo workspace; each mission closed achieved). Row 65 closed.

Browser 2026-11-12 (fresh Chrome tab; the old tab's renderer was frozen, a new tab works and is signed in): Setup page (all three steps done), Library overview (counts, hands-off switch), Outputs with the csv.query result read in the preview (23.25 points per sprint, correct, 4 of 4 criteria checked by tests/files/hashes). No new UX problems found on those pages.

Browser 2026-11-12 after deploy `e353c1c`: Live, Logs, Health walked; a new plain-words mission started from Today in the browser drafted its plan in ~30 s, one click confirmed it, ran hands-off, closed with 2 of 2 tasks independently checked, 23k tokens, results accepted, reuse shown (3 items), "Propose as Play" offered. Live rail no longer shows "unknown" as an engine name. The Live side panel now says "Not reported" instead of "unknown" (built and spec-passed, deploys with the next release).

Tools registry (Library > Tools) walked 2026-11-12: 7 trusted read tools; csv.query 2 calls none failed; documents.read 23 calls / 21 failed but the last failure was 11 Nov 14:07 (before the availability fix) and the 12 Nov calls succeeded; web.fetch 70 / 52 failed, last use 01:08 fine. The registry shows lifetime failure rates, so old failures keep reading as red until enough new calls dilute them (idea: also show the last 7 days).

Review inbox 2026-11-12: the ten unreadable old notes Brain had set aside ("Not kept: an older note with no mission or title") were still listed with an Approve button; they are now hidden (deployed, checked live). What genuinely waits for the owner there: 5 proposals (agent-instruction/tool candidates such as plan-guide-assistant, task-worker, operations-assistant, each with Approve/Reject); all other listed write-ups are already published by Brain and only offer Withdraw.

Tools registry now reads over the last 7 days with lifetime as secondary text (deployed 2026-11-12, `verify:fast`, 531 integration tests and the registry browser spec pass). The old failures of documents.read and web.fetch were only a day old, so they still fall inside the 7-day window and read red until they age out (about 2026-11-18); nothing is wrong with the tools now.

Dependabot: 3 moderate transitive advisories pinned in `pnpm-workspace.yaml` overrides 2026-11-12 (`72168f6`); `pnpm audit --prod` clean. One dev-only advisory remains (minimatch under `eslint-plugin-import-x`, which needs minimatch 10's `makeRe`; 11 breaks lint): wait for an import-x release.

## Not yet seen live
Needs-you "outcome unknown" row, Saved document in the Review inbox, scheduled Repeat occurrence (auto-confirm), notification preferences (email section), phone layout and install prompt on a real phone.

Seen live 2026-11-12 (API-driven, no browser): fresh plain-words mission on the deployed build (renamed runtime + tightened prompts): plan drafted in 25 s (2 tasks), confirmed, both tasks done, mission closed/achieved at 146 s with no manual step. Still needs a browser look when the owner re-allows the extension.

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; reuse and capitalisation are first-class.
