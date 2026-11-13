# Backlog: open items only (lean on purpose)

Dated 2026-11-11 ~23:15, at `talelk/brain@9393922` (deployed: everything through track AF). History of every track, report and finding: [archive/](archive/) (excluded from the agent context budget; latest [archive/backlog-2026-11-11-night.md](archive/backlog-2026-11-11-night.md)). Keep THIS file short: when an item is done, delete its row and note it in the archive.

## Process rules learned
- Run at most 2 agents at once and cap vitest workers (`maxWorkers: 4`): uncapped parallel test runs OOM-killed the machine and restarted the session twice. After a restart check each agent's worktree: its commits survive; merge them yourself.
- Stop each agent, remove its worktree and `~/.cache/tmp-<name>`, and kill only its own wait-loops (by exact pid, never `pkill -f` patterns that can match your own shell) as soon as its report is taken. Avoid deploying while missions run (a deploy interrupts running attempts).
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
| Run the phase 2 walkthrough with five Keyrus people who have never seen Brain (gate: all five finish unaided, no contradictory state, empty install to first verified result under 5 min) | phase 2 is built and tested (ADR 0024); only people can pass this gate. Remaining review findings: [archive/phase-2-one-surface-2026-11-13.md](archive/phase-2-one-surface-2026-11-13.md) |
| Create one share link and open it signed out | creating a public link grants access: the assistant is blocked from doing it; verify `/shared/:token` is read-only |
| Decide the quarantined tool proposals in Library (demo workspace: 5; sre-demos: 1 tool + 1 Play proposal "Keep the demos server healthy", filed 2026-11-12) | they need a person by design; approving the Play opens a Studio draft |
| Rotate the server sudo password | it was typed into chat several times |
| Optionally set `BRAIN_NOTIFY_SMTP_URL` / `BRAIN_NOTIFY_FROM` on the server | enables email notifications (off by default) |

## Open engine / quality rows
| # | Item | Notes |
|---|------|-------|
| 69 | Review and plan 2026-11-13 (functional, technical, UX, outputs, self-healing, capitalisation): five phases, gates and measures | Claude Doc https://claude.ai/artifact/LqLEk8pTtkZJskJYSxL4mw (owner's account); findings below are the new ones |
| 70 | Capitalization published failure: the sre-demos entry "Check all docker compose & running docker & propose limits plan" is Approved knowledge though it observed nothing | 2026-11-13 live; ADR 0022; withdraw that entry |
| 71 | Self-healing retries the same recipe, model and tools: Docker task, 6 attempts, 250k tokens; no failure classes, remedies or per-task spend cap (decided: 200k tokens per task, then park as `budget`); Quality "98.2%" leaves parked tasks out | 2026-11-13; ADR 0022; stall rate 10% (6 of 60) |
| 73 | Delivery and operations: no CI, laptop deploy, no scheduled backup or restore rehearsal, Health ignores the model endpoint, launcher and disk (also the raw nginx 502 page: add a maintenance page that retries), hard-coded admin password in `scripts/demo/provision-cv-insights.py` | 2026-11-13; plan phase 0 |
| 74 | The "no migrations" policy (AGENTS.md, implementation-policy.json) ends the day a team other than the owner keeps real data on an instance; then an ADR and a schema migration path | decided 2026-11-13 |
| 82 | Engine lane must fill `KnowledgeAsset.helpedCount` and `expiresAt` (optional contract fields the Library renders when present); the five-minute first-run gate was timed on the fixture engine only, not a real model | 2026-11-13; ADR 0024 |
| 80 | Order: phase 0 alone first; then phases 1 and 2 as two lanes (engine, web), 2 agents max; phase 3 waits for the phase 1 gate | decided 2026-11-13 |
| 76 | Build ADR 0022 and 0023: required-tools check at Done (tools come from the workspace default way of working, planner may override), capitalization refuses unobserved results, failure classes with one remedy each, per-workspace hosted model (demo workspace first) | accepted 2026-11-13 |
| 77 | Phase 0: CI `verify:change` on push; manual deploy job via ephemeral tailnet node and deploy-only key, refuses while missions run; nightly encrypted backup to a second host (14 nightly, 8 weekly), monthly timed restore | decided 2026-11-13; owner makes the tailnet key, picks the host |
| 78 | Standing test set: ~40 fixture tasks plus 5 replayed server tasks, nightly and on prompt, model or release change; a drop over 10 points blocks deploys | decided 2026-11-13 |
| 79 | First effect tools: restart one named container (privileged, permit per call, owner approves from a phone), then open a pull request; own ADR when built | decided 2026-11-13; plan phase 3 |
| 15 | Evaluator quality 2026-11-12: parsed 14/15, validator 14/15; the one failure was a model flake | detail in archive |
| 66 | Email: STARTTLS/smtps tested only against a fake server; `startSupervisor` loop not run end to end | test against a real relay before relying on it |
| 67 | RTL and languages: French and Arabic catalogue exists (ADR 0024) for the shell, Today, Missions, decision cards, Outputs, Library knowledge and the start box. The long tail still reads English (mission Plan/Live/Brief views, Plan canvas, Logs, Approvals, Runners, Studio, Administration pages); add keys with `scripts/i18n-add.py` and move strings behind `t()`. Compare view in RTL unseen | `scripts/i18n-missing.py` lists unused keys only; grep for literals |
| 68 | SRE host access (ADR 0021) ships read-only: `host.read` and `host.exec`. Missing: privileged commands (restart/reload, effect permit per call), a writable per-run output directory, a dedicated runner group so host tools exist only for the SRE workspace | when the owner wants host changes |

History and not-yet-seen-live list: [archive/backlog-2026-11-12.md](archive/backlog-2026-11-12.md).

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; reuse and capitalisation are first-class.
