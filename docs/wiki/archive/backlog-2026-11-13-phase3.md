# Phase 3, from reports to actions (2026-11-13)

Rows 68 (SRE host changes, runner group) and 79 (first effect tools) closed by this phase; decisions in ADR 0024.

## Built (all tested through the Governor integration harness unless noted)
- Effect tools with a permit per call: `governance/effects.ts` (request, status, permit, start, finish), runner gate `apps/runner/src/tools/effects.ts`, supervisor flow, evidence reconciliation (`domain_operation_receipts`, effects and approval ids in the bundle). Tests `effect-gate`, `effect-scheduled`, `effect-pull-request`, `effect-connectors`, `tool-selftest` (integration) and `effect-permits`, `host-commands` (security).
- Tools in the starter release: `host.restart` and `host.reload` (privileged, launcher commands `docker.restart` and `service.reload`, single-use ledger at `<socket>.effects`), `ticket.create`, `message.send`, `git.open-pr` (Governor performs them; credentials never leave it). The `sre-operator` agent lists them; `sre-task` runs on group `sre-host`.
- Runner groups: `runnerGroup.set` (a group takes only its workspaces; host-tool agents are offered only to a host group; the Governor refuses a host effect from another group). Allow-list: `workspace.effects.set` (containers, services, approval minutes).
- Connectors: Slack and Teams bodies for the notification webhook (`BRAIN_NOTIFY_WEBHOOK_FORMAT`), signed inbound chat webhook `POST /hooks/chat` (`approvals`, `status`, `deny <id>`, `approve <id>` answers with the link; never approves), generic ticket webhook adapter, email test and Health `email` line, deep link `/approvals/:id` in approval notifications.
- Tool self-test (`selftest.<tool>` scripts staged with the release; runner mode runs `test.sh` beside the pinned `run.sh`, sandboxed when a launcher exists) and the Git connection checklist (`integrations.guide`).

## Live steps (row 85) in detail
1. Deploy, restage the release (`scripts/stage-demo-release.sh`): the digests of the SRE agent and workflow changed.
2. Launcher host: copy `scripts/demo/host-commands.json` (two new privileged commands), restart the launcher. Privileged runs write `<socket>.effects`; keep it with the launcher state.
3. Runner: a runner in group `sre-host` with the launcher socket and `BRAIN_TOOL_DATA_MOUNTS`; remove host mounts from other groups. A `RunnerGroup` document `sre-host` is in the release.
4. `BRAIN_SRE_RESTARTABLE=name1,name2 scripts/provision-sre-demos.sh`: sets the group and the allow-list (empty by default: every restart is refused).
5. The owner must be an `approver` or `workspace-lead` of the SRE workspace to be notified and to decide.
6. Notification and connector settings are server environment (never stored): `BRAIN_BASE_URL`, `BRAIN_NOTIFY_WEBHOOK_*`, `BRAIN_INBOUND_WEBHOOK_SECRET` (min 16 characters; Slack slash command URL `/hooks/chat`), `BRAIN_TICKET_WEBHOOK_URL|TOKEN|SECRET`.
7. Gate rehearsal: schedule a watch (`automation.upsert`, target workflow `sre-task`), stop a demo container, approve from a phone, check the restart in Logs and the evidence.
