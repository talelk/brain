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
| Plan / Live / Outputs / admin review of 2026-11-12: 38 of 59 findings fixed and deployed, 21 open | list with status in `docs/wiki/archive/review-plan-live-outputs-2026-11-12.md` |
| Create one share link and open it signed out | creating a public link grants access: the assistant is blocked from doing it; verify `/shared/:token` is read-only |
| Decide the quarantined tool proposals in Library (demo workspace: 5; sre-demos: 1 tool + 1 Play proposal "Keep the demos server healthy", filed 2026-11-12) | they need a person by design; approving the Play opens a Studio draft |
| Rotate the server sudo password | it was typed into chat several times |
| Optionally set `BRAIN_NOTIFY_SMTP_URL` / `BRAIN_NOTIFY_FROM` on the server | enables email notifications (off by default) |

## Open engine / quality rows
| # | Item | Notes |
|---|------|-------|
| 69 | Review and plan 2026-11-13 (functional, technical, UX, outputs, self-healing, capitalisation): five phases, gates and measures | Claude Doc https://claude.ai/artifact/LqLEk8pTtkZJskJYSxL4mw (owner's account); findings below are the new ones |
| 70 | Capitalisation publishes failure: the sre-demos entry "Check all docker compose & running docker & propose limits plan" is Approved knowledge although its text says nothing was observed | 2026-11-13 live. Publish only results with observed evidence; an answer that could not observe is "Could not do", not Done; withdraw that entry |
| 71 | Self-healing retries the same recipe, model and tools: the Docker task ran 6 attempts and 250k tokens; no failure classes, no remedy per class, no spend cap across attempts, no lesson recorded | 2026-11-13. Quality page: stall rate 10% (6 of 60); its "Verified without human help 98.2%" leaves parked tasks out of the denominator |
| 72 | Outputs on live: 91 of the 100 files shown are one failing task (90 run records of its attempts); "Needs review 0" while a result reads "Needs changes"; cards show raw run ids; no mission-level answer | 2026-11-13. Fold attempt records under "Attempts"; true counts |
| 73 | Delivery and operations: no CI, deploy from a laptop, no scheduled backup or restore rehearsal, Health does not check the model endpoint, launcher or disk; `scripts/demo/provision-cv-insights.py` hard-codes an admin password; web app has 68 independent refresh timers | 2026-11-13. Phase 0 and Phase 2 of the plan |
| 15 | Evaluator quality re-measured 2026-11-12 on the deployed prompts (qwen3.8-flash-next-a5b, 3 runs per sample): parsed 14/15, validator 14/15; both old-style review samples passed 3/3 (the earlier weak spot did not recur). The one failure was a review-with-upstream answer with malformed JSON (unparsed), a random model flake, not criteria semantics | watch the live retry behaviour on unparsed answers; consider a stricter JSON instruction only if flakes recur |
| 66 | Email: STARTTLS/smtps only tested against a fake server; whole `startSupervisor` loop not run end to end (only `runClaimLoops`) | test against a real relay before relying on it |
| 67 | RTL checked live 2026-11-12: layout mirrors correctly (sidebar right, arrows flipped, buttons at the start edge) and mixed Arabic/English text reads correctly. Remaining quirk: English UI strings in RTL put trailing punctuation on the left; do not patch with bidi CSS, it goes away with Arabic translations. Compare view in RTL still unseen | needs Arabic translations of the UI copy (no message catalog exists yet) |
| 68 | SRE host access (ADR 0021) ships read-only: `host.read` and `host.exec`. Missing: privileged commands (restart/reload, effect permit per call), a writable per-run output directory, a dedicated runner group so host tools exist only for the SRE workspace | when the owner wants host changes |

History of 2026-11-12 (deploys, live checks, tools registry, review inbox, Dependabot): [archive/backlog-2026-11-12.md](archive/backlog-2026-11-12.md).

## Not yet seen live
Needs-you "outcome unknown" row, Saved document in the Review inbox, scheduled Repeat occurrence (auto-confirm), notification preferences (email section), phone layout and install prompt on a real phone.

Seen live 2026-11-12 (API-driven, no browser): fresh plain-words mission on the deployed build (renamed runtime + tightened prompts): plan drafted in 25 s (2 tasks), confirmed, both tasks done, mission closed/achieved at 146 s with no manual step. Still needs a browser look when the owner re-allows the extension.

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; reuse and capitalisation are first-class.
