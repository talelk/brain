# UI revamp screen inventory

Baseline audited 2026-10-31 against the 34 supplied 1440×900 references, generated route contract, current Solid components and typed Governor read models. Route names below are actual routes, not inferred filenames. All listed screens currently render; “revamp status” tracks the new composition, not route existence.

| # | Reference | Actual route | Owning component(s) | Typed reads | Existing actions | Revamp status |
|---|---|---|---|---|---|---|
| 01 | `01-today.png` | `/today` | `TodayPage` → `TodayScreen` | `today` | open exact source; start task | implemented |
| 02 | `02-bridge.png` | `/bridge` | `BridgePage` → `BridgeScreen` | `bridge` | open workspace | implemented |
| 03 | `03-workspace-overview.png` | `/w/:id/overview` | `WorkspaceOverviewPage` → `WorkspaceOverview` | `workspace.context`; readiness doctor | start work | implemented |
| 04 | `04-board.png` | `/w/:id/board` | `BoardPage` → `WorkBoard` | `workBoard.get` | `workItem.transition`, `workItem.comment`; plan/task links | implemented |
| 05 | `05-plans.png` | `/w/:id/plans` | `PlansPage` | `workBoard.get`, plan detail | plan create/propose/confirm | implemented |
| 06 | `06-schedules.png` | `/w/:id/schedules` | `SchedulesPage` | `automations.list`, `automations.occurrences` | `automation.upsert`, `automation.control` | implemented |
| 07 | `07-resources.png` | `/w/:id/resources` | `ResourcesPage` | `documents.list/get/search` | upload/revise/associate/revoke | implemented |
| 08 | `08-start-work.png` | `/w/:id/workflows` | `WorkflowsPage`, `TaskEntry`, `TaskReview`, `Conversation` | `workflows.list`, readiness, drafts/conversations | reviewed draft start; linked origins | implemented |
| 09 | `09-activity.png` | `/w/:id/runs` | `RunsPage` → `RunsScreen` | `jobs.list`, `sessions.list`, `runners.list` | bounded pages, filters, open detail, dispatch | implemented |
| 10 | `10-run-detail.png` | `/jobs/:id` | `JobDetailPage` → `RunDetail` | `job.get`, `job.explain`, `sessions.list` | cancel; reconcile unknown outcome | implemented |
| 11 | `11-agents.png` | `/w/:id/agents` | `AgentsPage`, `AgentDetail` | `agents.list`, related `workflows.list` | diagnostic dispatch | implemented |
| 12 | `12-support.png` | `/w/:id/support` | `SupportPage` → `SupportScreen` | `tickets.list`, `sla.summary` | open ticket; support task route | implemented |
| 13 | `13-ticket-detail.png` | `/tickets/:id` | `TicketDetailPage` → `TicketDetailScreen` | `ticket.get` | approval review; linked tasks | implemented |
| 14 | `14-incidents.png` | `/w/:id/sre` | `SrePage` → `SreScreen` | `incidents.list` | open incident; SRE task route | implemented |
| 15 | `15-incident-detail.png` | `/incidents/:id` | `IncidentDetailPage` → `IncidentDetailScreen` | `incident.get` | linked tasks | implemented |
| 16 | `16-delivery.png` | `/w/:id/delivery` | `DeliveryPage` → `DeliveryScreen` | `delivery.list/get`, board context | record business Go decision | implemented |
| 17 | `17-knowledge.png` | `/w/:id/knowledge` | `KnowledgePage` → `KnowledgeScreen` | `memory.search`, tool/capitalization/config reads | publish/revoke reviewed knowledge | implemented |
| 18 | `18-tools.png` | `/tools` | `ToolsPage` → `ToolsScreen` | `tools.list`, candidates | propose/publish with evidence | implemented |
| 19 | `19-runners.png` | `/runners` | `RunnersPage` → `RunsScreen(initialTab=runners)` | `runners.list` (with jobs/sessions) | open runner | implemented |
| 20 | `20-runner-detail.png` | `/runners/:id` | `RunnerDetailPage` → `RunnerDetailScreen` | `runner.get` | drain/quarantine with reason | implemented |
| 21 | `21-approvals.png` | `/approvals` | `ApprovalsPage` → `ApprovalsScreen` | `approvals.list` | single review and decision | implemented |
| 22 | `22-approval-detail.png` | `/approvals/:id` | `ApprovalDetailPage` → `ApprovalDetailScreen`, `ApprovalReview` | `approval.get`, scoped audit | exact decision, recovery, revoke | implemented |
| 23 | `23-decisions.png` | `/w/:id/decisions` | `DecisionsPage` → `DecisionsScreen` | `decisions.list`, board context | append decision | implemented |
| 24 | `24-settings-setup.png` | `/settings?tab=setup` | `SettingsPage`, `LocalModelSetup`, `OperationalChecklist` | doctor, local runtime | model connect/test; owning-flow links | implemented |
| 25 | `25-settings-security.png` | `/settings?tab=security` | `SettingsPage`, `SecurityAndIntegrations`, `SessionControls` | identity, sessions | TOTP, passkeys, revoke sessions, push | implemented |
| 26 | `26-settings-integrations.png` | `/administration/integrations` | `IntegrationsPage` | `integrations.list/repositories` | connect/verify/bind | implemented |
| 27 | `27-settings-release.png` | `/settings?tab=release` | `SettingsPage`, `InspectRelease` | staged/active release and config explain | inspect/activate with expected digest | implemented |
| 28 | `28-settings-members.png` | `/settings?tab=members` | `SettingsScreen` access section | `members.list`, organization members | grant/revoke workspace role | implemented |
| 29 | `29-settings-invitations.png` | `/settings?tab=invitations` | `OrganizationInvitations` | `organization.invitations.list` | create/cancel/retry delivery | implemented |
| 30 | `30-settings-policy.png` | `/settings?tab=policy` | `OrganizationAuthPolicy` | `organization.auth-policy.get` | read-only effective policy | implemented |
| 31 | `31-session-detail.png` | `/sessions/:id` | `SessionDetailPage` → `SessionFeed` | `session.get`, bounded SSE replay | steer/stop when active | implemented |
| 32 | `32-settings-health.png` | `/settings?tab=health` | `SettingsScreen`, `DiagnosticExport` | `platform.health`, `audit.list` | diagnostics export | implemented |
| 33 | `33-tv-support.png` | `/tv/support` | `TvSupportPage` → `TvBoard(area=support)` | `tickets.list`, `sla.summary` | read-only auto-refresh | implemented |
| 34 | `34-tv-sre.png` | `/tv/sre` | `TvSrePage` → `TvBoard(area=sre)` | `incidents.list` | read-only auto-refresh | implemented |

## Baseline observations

- All 34 reference images were inspected in `artifacts/ui-revamp/baseline/contact-1.jpg` through `contact-6.jpg`.
- The dominant implementation pattern is `Section(surface=card)` around another bordered collection. Runners reuse Activity, and narrow `PaneLayout` defaults leave substantial desktop canvas unused.
- Existing authority behavior is significant and must be preserved: exact draft start recovery, expected versions, one-use approval evidence and decision-status recovery, no generic Retry for unknown effects, verified evidence on the board, and scoped-read eviction.
- The route contract calls the board query `board.get`, while the current implementation uses the canonical `workBoard.get`; transition/comment commands likewise use `workItem.*`. This is a docs/generated-contract discrepancy, not permission to rename working server APIs without a coordinated contract change.
- The route contract lists six primary areas including Administration; the current requested shell retains five user destinations with Administration through account/admin access. The current shell already follows the requested five-destination model.
- Baseline `pnpm build`: passed (server/contracts typecheck, web strict typecheck, Vite production build). Initial `index` JavaScript: 75.30 KiB gzip; CSS: 34.27 KiB gzip.
- Baseline unchanged Playwright matrix was started before source edits. Its final result is recorded in `screen-acceptance.md` and the verification notes.
