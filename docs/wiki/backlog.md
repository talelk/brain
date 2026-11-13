# Backlog: open items only (lean on purpose)

Dated 2026-11-11 ~23:15, at `talelk/brain@9393922` (deployed: everything through track AF). History of every track, report and finding: [archive/](archive/) (excluded from the agent context budget; latest [archive/backlog-2026-11-11-night.md](archive/backlog-2026-11-11-night.md)). Keep THIS file short: when an item is done, delete its row and note it in the archive.

## Process rules learned
- Run at most 2 agents at once and cap vitest workers (`maxWorkers: 4`): uncapped parallel runs OOM-killed the machine twice. After a restart check each worktree; its commits survive.
- Stop each agent, remove its worktree and `~/.cache/tmp-<name>`, and kill only its own wait-loops (by exact pid) once its report is taken. Deploys now drain running attempts first (`scripts/drain-live.mjs`).
- Playwright "Executable doesn't exist" means the browser cache vanished: `npx playwright install chromium`; `pnpm build` before browser specs and run them for every UI or read-model change before deploying.
- Deploy = `scripts/deploy-demo.sh` (pre-check on a VACUUM INTO snapshot) then `scripts/stage-demo-release.sh` when `examples/v1` changed; new columns on existing tables need DEFAULT; retry a failed `git push`.
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
| 72 | Outputs on live: 91 of 100 files are one failing task's attempt records; "Needs review 0" beside a "Needs changes" result; raw run ids on cards; no mission-level answer | 2026-11-13; fold attempts, true counts |
| 73 | Delivery and operations: no CI, laptop deploy, no scheduled backup or restore rehearsal, Health ignores the model endpoint, launcher and disk, hard-coded admin password in `scripts/demo/provision-cv-insights.py`, 68 independent web refresh timers | 2026-11-13; plan phases 0 and 2 |
| 74 | The "no migrations" policy (AGENTS.md, implementation-policy.json) ends the day a team other than the owner keeps real data on an instance; then an ADR and a schema migration path | decided 2026-11-13 |
| 75 | Navigation to Today, Missions, Library, Administration; Live, Logs, Outputs become mission views; Today "Working now" strip, Missions Running filter, Logs under Administration | decided 2026-11-13; plan phase 2 |
| 80 | Order: phase 0 alone first; then phases 1 and 2 as two lanes (engine, web), 2 agents max; phase 3 waits for the phase 1 gate | decided 2026-11-13 |
| 81 | UX: 7 of the 21 open findings (refresh clocks) go with the phase 2 live store; fix the other 14 before the five testers start | decided 2026-11-13 |
| 82 | Phase 1 live steps after deploy: re-run `scripts/provision-sre-demos.sh` (sets the way of working: sre-task, host.read + host.exec); run `knowledge.withdrawUnobserved` there (withdraws the docker-limits entry); `pnpm standing-tests -- --record-baseline` on a host that reaches the model | engine lane 2026-11-13; the gate passes with no baseline until the last step |
| 83 | Hosted model: Governor side done (route in job payload, hold while down, Health, switch); the Pi second attempt honours it, the Claude evaluator engine does not (process-global env) | needs a per-attempt endpoint for the Claude engine |
| 84 | Web lane to show: WorkItem `failureClass` `remedy` `requiredTools` `tokenCap` `tokensUsed`; KnowledgeAsset `expiresAt` `helpedCount`; Quality `failureReasons.items[].code`; queries `engineSettings.get` `lessons.list`; Health services `model` `disk` `launcher` `hosted-model`; commands `workItem.spendCap.raise` `workspace.wayOfWorking.set` `workspace.hostedModel.set` `platform.drain.set` `knowledge.withdrawUnobserved` | engine lane 2026-11-13 |
| 77 | Phase 0: CI `verify:change` on push; manual deploy job via ephemeral tailnet node and deploy-only key, refuses while missions run; nightly encrypted backup to a second host (14 nightly, 8 weekly), monthly timed restore | decided 2026-11-13; owner makes the tailnet key, picks the host |
| 79 | First effect tools: restart one named container (privileged, permit per call, owner approves from a phone), then open a pull request; own ADR when built | decided 2026-11-13; plan phase 3 |
| 68 | SRE host access (ADR 0021) ships read-only: `host.read` and `host.exec`. Missing: privileged commands (restart/reload, effect permit per call), a writable per-run output directory, a dedicated runner group so host tools exist only for the SRE workspace | when the owner wants host changes |

History and not-yet-seen-live list: [archive/backlog-2026-11-12.md](archive/backlog-2026-11-12.md); watch rows (15, 66, 67): [archive/backlog-2026-11-13-watch-rows.md](archive/backlog-2026-11-13-watch-rows.md).

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; reuse and capitalisation are first-class.
