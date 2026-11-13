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
| Connect a Git repo (Administration > This workspace > Integrations: a connection with a token, then bind it to the workspace: `configuration` write for Edit this tool, `project` write for pull requests). The checklist is the query `integrations.guide` | Edit this tool and the pull request tool (ADR 0024) publish only through a verified write binding; the live server has none |
| Capability-gap auto-heal: when a task fails because its agent lacks a tool it needs, switch it to a recipe whose agent has it (needs plan tasks to declare required tools, or a per-workspace default recipe) | 2026-11-12: the docker inspection task failed 3x on general-task (no host.exec); sre-task is `system`, so the planner never picks it. Run this task with (deployed) is the manual fix |
| Run the phase 2 walkthrough with five Keyrus people who have never seen Brain (gate: all five finish unaided, no contradictory state, empty install to first verified result under 5 min) | phase 2 is built and tested (ADR 0024); only people can pass this gate. Remaining review findings: [archive/phase-2-one-surface-2026-11-13.md](archive/phase-2-one-surface-2026-11-13.md) |
| Create one share link and open it signed out | creating a public link grants access: the assistant is blocked from doing it; verify `/shared/:token` is read-only |
| Decide the quarantined tool proposals in Library (demo workspace: 5; sre-demos: 1 tool + 1 Play proposal "Keep the demos server healthy", filed 2026-11-12) | they need a person by design; approving the Play opens a Studio draft |
| Rotate the server sudo password | it was typed into chat several times |
| Optionally set `BRAIN_NOTIFY_SMTP_URL` / `BRAIN_NOTIFY_FROM` on the server, then send a test email (`POST /v1/notification-preferences/email-test`); Health shows an `email` line | enables email notifications (off by default); row 66 still wants a real relay |

## Open engine / quality rows
| # | Item | Notes |
|---|------|-------|
| 69 | Review and plan 2026-11-13 (functional, technical, UX, outputs, self-healing, capitalisation): five phases, gates and measures | Claude Doc https://claude.ai/artifact/LqLEk8pTtkZJskJYSxL4mw (owner's account); findings below are the new ones |
| 73 | Delivery and operations: no CI, laptop deploy, no scheduled backup or restore rehearsal, hard-coded admin password in `scripts/demo/provision-cv-insights.py` | 2026-11-13; plan phases 0 and 2 (Health now shows model, disk, launcher; one live store replaced the refresh timers: ADR 0028) |
| 74 | The "no migrations" policy (AGENTS.md, implementation-policy.json) ends the day a team other than the owner keeps real data on an instance; then an ADR and a schema migration path | decided 2026-11-13 |
| 82 | Phase 1 live steps after deploy: re-run `scripts/provision-sre-demos.sh` (sets the way of working: sre-task, host.read + host.exec); run `knowledge.withdrawUnobserved` there (withdraws the docker-limits entry); `pnpm standing-tests -- --record-baseline` on a host that reaches the model | engine lane 2026-11-13; the gate passes with no baseline until the last step |
| 85 | Phase 3 live steps after deploy (owner). Until a runner joins group `sre-host`, every SRE task stays queued (the SRE workflow moved to that group), so do the runner step first: restage the release (tools host.restart, host.reload, ticket.create, message.send, git.open-pr, `selftest.*` scripts, group `sre-host`); put `docker.restart` and `service.reload` from `scripts/demo/host-commands.json` on the launcher host and restart the launcher; enroll a runner in group `sre-host` (pi engine, launcher socket, data mounts) and give host tools to no other group; run `scripts/provision-sre-demos.sh` with `BRAIN_SRE_RESTARTABLE=<containers>`; make the owner an approver of that workspace; set `BRAIN_BASE_URL`, `BRAIN_NOTIFY_WEBHOOK_URL` (+ `_FORMAT=slack\|teams`, `_SECRET`), `BRAIN_INBOUND_WEBHOOK_SECRET`, `BRAIN_TICKET_WEBHOOK_URL` (+ `_TOKEN`, `_SECRET`) as wanted | detail [archive/backlog-2026-11-13-phase3.md](archive/backlog-2026-11-13-phase3.md) |
| 86 | Phase 3 gate on the real demos server (one real incident, one approval from a phone) is not run: tested only with a real launcher and runner supervisor on a simulated host, no Docker, no real vendor | needs row 85 and the owner's phone |
| 88 | Real-vendor tests of Slack, Teams, GitHub, GitLab and a ticketing system (all tested against fakes; the Teams signature and `files.write` are built) | needs accounts |
| 98 | The five-minute first-run gate was timed on the fixture engine only, not a real model | 2026-11-13; ADR 0024 (`helpedCount` and `expiresAt` are filled and shown) |
| 90 | Phase 4 live steps (owner), each off until set up: single sign-on (`identity.oidc.set` with a real directory tenant; register the redirect address `identity.oidc.get` shows; secret in a 0600 file); replica (`replica.env`, second host user and ssh key, re-run the deploy); metrics (token file, `BRAIN_METRICS_TOKEN_FILE` in `.env`, Prometheus and Alertmanager with on-call routing, rules in `deploy/monitoring/`); second runner host (`deploy/demo/runner-host/enroll-runner-host.sh`) | built and tested against a fake directory, a fake second host and fixture runners; needs a tenant, a host, Prometheus; steps in `docs/howto/sso-and-monitoring.md`, `docs/howto/replica-and-second-runner.md` |
| 91 | Phase 4 gate not run: 3 teams, 50 missions a week, 99.5% availability over four weeks | operational; needs row 90 and the teams |
| 93 | The replica is a snapshot loop (loss window = interval + shipping, minutes), failover not rehearsed on a real second host; a Litestream sidecar would give seconds (ADR 0027) | decide only if the measured loss matters |
| 94 | Event payloads carry `traceId` (Phase 4); no web screen shows it yet (Logs could link correlated events by it) | web lane |
| 95 | Schema migrations: runner built, list empty (ADR 0025) | activates when row 74 is decided |
| 97 | Leftover-lane live steps (owner, with the next deploy): the deploy's schema repair adds indexes and `effect_calls` columns; restage the release (tool `files.write`, granted to no agent yet); optional `BRAIN_INBOUND_TEAMS_TOKEN`; first real held change (ADR 0028) not yet seen live. Web lane: a job `blocked` with reason `AWAITING_APPROVAL` is a task waiting for a person, and a held `act` job (step `act`) appears in runs | 2026-11-13 |
| 67 | RTL and languages: French and Arabic exist for the shell, Today, Missions, decision cards, Outputs, Library, Administration, Approvals, the mission page and Plan stage, Quality, Schedules, Health and Library tools (checked at 390 px, `translations-tail.spec.ts`). Still English: sign-in screens, Logs, Studio, Live, Support/Incidents, Outputs compare, a few computed sentences (occurrence notes), the design system's own placeholders ("Select..."), and server-written detail lines (Health, checklist advice). Compare view in RTL unseen | add keys with `scripts/i18n-add.py`; grep for literals |
| 77 | Phase 0: CI `verify:change` on push; manual deploy job via ephemeral tailnet node and deploy-only key, refuses while missions run; nightly encrypted backup to a second host (14 nightly, 8 weekly), monthly timed restore | decided 2026-11-13; owner makes the tailnet key, picks the host |

History and not-yet-seen-live list: [archive/backlog-2026-11-12.md](archive/backlog-2026-11-12.md); watch rows (15, 66, 67): [archive/backlog-2026-11-13-watch-rows.md](archive/backlog-2026-11-13-watch-rows.md).

## Standing rules (see goal-and-user.md)
Validate every change in a real browser as a first-time user; do not stop until nothing is left; reuse and capitalisation are first-class.
