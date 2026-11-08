# 09 — Product experience and UI implementation contract

## Product principle

Design for three human decisions: what needs attention, what is happening, and what is safe to authorize. The default screen is a prioritized work list with a clear next action and freshness, not a wall of charts. Every status links to its evidence or blocker. Technical identifiers/digests are available in details; ordinary users see task, workspace, target, reason and next action first.

Use [NewUI](https://talelk.github.io/newui/) as the UI foundation. Its semantic tokens, public atomic packages and templates establish Brain's visual system. The following task flows remain Brain-owned. Document 16 defines the integration and component map; it replaces the previous proposal to construct a parallel Solid/Zag kit. Validate the composed workflows with operators before broadening the surface.

## Information architecture

Use five primary navigation areas: **Missions, Live, Logs, Outputs and Plays**, with Knowledge as a secondary place and Administration in the account menu. Workspace selection scopes operational areas. Work includes objectives/plans, board, tasks, schedules, sessions, resources and pack views; Activity has jobs/sessions/history; Knowledge includes documents, capabilities and specialized Studios; Administration includes Git integrations, models, members, runners, policies, storage and releases. Personal security and preferences stay in the account menu; TV has a dedicated kiosk entry. A contextual Workspace Create action and Ask Brain converge on the same reviewed drafts and commands as manual creation. Primary and contextual destinations share the shell's grouped responsive sidebar rather than a second horizontal tab strip.

The following route index is generated from `contracts/v1/ui-screen-contracts.json`:

<!-- BEGIN GENERATED ROUTES -->
| Route | Main area | Primary task | Essential content |
|---|---|---|---|
| `/w/:id/missions` | missions | Act on what needs you, then open a mission | attention, tier, mission, state, spend |
| `/w/:id/missions/new` | missions | Start a mission from a play or a description | play, intent, criteria, constraints, autonomy, budget |
| `/missions/:missionId/:tab` | missions | Follow and steer one mission | live, team, plan, brief, logs, outputs |
| `/w/:id/plays` | plays | Start a mission from a play, run a single task, or describe the work | play, task, describe, origin, review |
| `/plays/:id` | plays | Review a play or single task, its schedules and history, then start it | brief, team, plan, inputs, schedules, history |
| `/administration/workspaces` | administration | Manage workspaces | workspace, state, counts |
| `/w/:id/live` | live | Run, steer and inspect live agent sessions without losing session state | sessions, console, outputs, controls, mission |
| `/w/:id/logs` | logs | Search execution and platform logs and jump between correlated contexts | records, filters, search, correlation, runs, state |
| `/w/:id/outputs` | outputs | Browse authorized generated artifacts with previews, diffs and history | artifacts, preview, history, diff |
| `/outputs/:id` | outputs | Inspect a named output, its versions and lineage | versions, lineage, preview, verification, provenance |
| `/outputs/:id/compare` | outputs | Compare two versions of an output with their provenance | diff, provenance |
| `/approvals` | missions | Review exact proposed effects and recover submitted decisions | action, workspace, target, expiry, evidence |
| `/approvals/:id` | missions | Review exact proposed effects and recover submitted decisions | exactContent, precondition, subjectDigest, history |
| `/runs/:id` | live | Inspect one run's state, attempts, evidence and links without duplicating the console, logs or outputs | state, attempts, blocker, evidence |
| `/runners` | live | Inspect a run, its attempts, events and evidence | group, trust, health, capacity, freshness |
| `/runners/:id` | live | Inspect a run, its attempts, events and evidence | capabilities, attempts, reservations |
| `/sessions/:id` | live | Open one session in the Live console: active and historical are state, not layout | console, task, usage, context |
| `/w/:id/plays/support` | plays | Review workspace work and pack details | priority, ticket, state, sla |
| `/tickets/:id` | plays | Review workspace work and pack details | body, draft, evidence, approval |
| `/w/:id/plays/sre` | plays | Review workspace work and pack details | severity, target, state, freshness |
| `/incidents/:id` | plays | Review workspace work and pack details | observations, remediation, evidence |
| `/w/:id/knowledge` | knowledge | Find scoped knowledge, documents and trusted tools | source, scope, freshness, review, capitalization, provenance, candidateTests, releaseGate, documents, tools |
| `/w/:id/knowledge/review` | knowledge | Review knowledge and capability candidates | runs, assets, candidates, decision |
| `/settings` | administration | Manage explicitly authorized administration | members, people, invitations, access, authenticationPolicy, audit, health |
| `/accept-invitation/:id` | administration | Verify an invited account and accept organization membership | invitedSignUp, emailVerification, explicitAcceptance |
| `/tv/:play` | tv | Read scoped redacted monitoring | aggregateStatus, freshness |
| `/studio/:kind` | knowledge | Create and validate a capability without editing YAML | definitions, drafts, validation, dependencies |
| `/studio/:kind/:draftId` | knowledge | Edit, test, review and publish an immutable definition | editor, diagnostics, diff, tests, publication |
| `/administration/integrations` | administration | Connect Git providers and bind repositories to workspaces | providers, organizations, repositories, permissions, webhooks, status |
<!-- END GENERATED ROUTES -->

Routes use immutable object IDs; workspace slug is presentation only. Cross-workspace links check access before displaying data. Deep links preserve selected workspace, filters and view; Back returns to list position. Global search is permission-filtered and uses typed categories.

## Shell and navigation

Use `AppShell` from `@talelk/newui-templates` for authenticated routes. Supply Brain brand, workspace switcher, grouped navigation, settings/account and header actions through its public slots. Keep its single responsive navigation model: docked/collapsible at desktop widths, modal drawer on tablet/mobile. At the reviewed revision its desktop breakpoint is 1024 px; inherit supported sizing instead of imposing another 224 px/56 px shell. Use `PaneLayout` for desktop list/detail views and explicit mobile list → detail → Back behavior. Use `AuthLayout` with `AuthCard` for sign-in; Better Auth owns actual identity. Mobile approval actions remain a clearly labeled touch-sized action area within the content.

Prefer progressive disclosure: summary row → detail → evidence/raw diagnostics. Command palette is optional; every command has an ordinary visible route. Workspace context is always visible near an effect action. Settings/admin tools are role-filtered but server authorization remains authoritative.

## Token and component contract

Import `@talelk/newui-tailwind/style.css` once in `apps/web/src/index.css`. Consume NewUI's surface/ink/outline, typography, focus, motion, spacing and radius roles. Include application and Brain composition files in Tailwind source scanning, and verify the selected package's published CSS/source integration in a production build. Keep only product-specific layout additions in `apps/web/src/ui/brain.css`; remove the earlier independent hex palette and token-file proposal. Use one owned `createColorScheme` controller from the atoms package and a shared `UIProvider` where direction/portal context is needed. Test real light/dark/forced-color combinations.

Follow NewUI's type roles and Inter font treatment, preserving font licensing and an available fallback. Use tabular numerals for metrics/timestamps. The reviewed density defaults to `sm` (28 px); choose `md` (32 px) explicitly when the task needs it. Retain at least 44 px mobile hit areas for Brain's primary actions through supported sizing or composition without changing NewUI's global density. Respect text scaling and the shared spacing/radius roles.

Reuse NewUI's atoms for controls/marks, molecules for interactions/overlays, organisms for data regions, and its three templates for page structure. For example, use `TextInput` rather than inventing an `Input` export, `Dialog`/`BottomSheet` for review flows, `Badge` for domain status presentation, `DataTable`/`VirtualList` for bounded data views and `KanbanBoard` for work. Implement ApprovalReview, EvidenceList, DiffViewer and ResourceMeter only as Brain domain compositions. A missing export requires checking the pinned source and recording a gap; no speculative prop names, deprecated package imports, raw Zag replacement or second component system.

Statuses use text/icon/color together. Distinguish Queued, Waiting for approval, Waiting for runner, No capacity, Running, Cancellation requested, Verifying, Partial, Outcome unknown, Failed, Succeeded. Do not display a green check because an agent said “done”. Unknown outcome uses an explicit “Reconcile before retry” action and disables unsafe retry.

## Critical flows

### Plays and single tasks

A declared workflow is a one-task Play. `/w/:id/plays` lists the active release's Plays and single tasks, and is where work is described ("Describe the work") or started from a ticket, incident or work item; a picked Play or task opens `/plays/:id`. A Play's page shows its brief, team roles, plan shape, schedules and triggers and the missions it started, and Start opens `/w/:id/missions/new` prefilled; a task's page reviews its typed inputs and dispatches it, with its schedules and the agents it runs. The release compiler refuses a Play and a Workflow with the same id. Schedules live on the object they start: a Play, a task, or a mission's work items (the mission Plan tab). Active agent definitions are inspected on the Play that uses them and authored in the Agent Studio.

### Dispatch

Choose workspace and declared workflow, fill typed inputs, see execution mode, target/environment, estimated cost, runner requirements and likely blockers. Submit once with an idempotency key. After durable acceptance navigate to the job/run page; show queued reason immediately. Retries after network timeout reuse the key. Validation errors focus the first invalid field, preserve user input and include a summary.

### Exact approval

Inbox rows show action, workspace, environment, requester, evidence readiness and expiry. Review page displays a plain-language effect sentence, stable target identity, exact proposed text/diff, source revision, current precondition, independent evidence and any reservations. Advanced drawer displays digests/policy/attempt details. Changes refresh to a new proposal; never keep an approve button active for a stale payload.

Approve opens a focused confirmation containing target and effect bounds and requests required step-up. Decision binds the displayed digest; stale version returns a refresh state without losing the human note. Reject/request changes require a concise note; approval note optional unless policy requires it. No bulk approval for production effects in V1. Disable double submission during pending receipt, but recover after timeout by querying the same key. “Approved, awaiting execution” is separate from “Executed, verified”.

Approval notification opens review; notification action itself does not approve. An expired/revoked/already-consumed request displays the decision history and next safe action. Draft older than 12 hours is flagged for revalidation; stale target/evidence blocks according to policy, not merely an orange warning.

### Live session

Group timeline by model turn and tool call; collapse verbose output, lazy-load raw logs, pin task and budget. Auto-follow only when user is at bottom; new-event count appears when scrolled up. Preserve text selection and scroll anchor. Show reconnecting/stale cursor separately from agent inactivity. Steer opens a message composer only for a supported authorized engine; stop requests remote cancellation and remains pending until acknowledged. Do not show a fake terminal for an engine that only provides structured events.

### Board and decisions

Dragging is optional. Keyboard/menu “Move to” supports every transition and optimistic version checks. Done is disabled until verified evidence is present; display missing criteria with links. Business Go/No is separate from production-effect approval. If moving conflicts with a remote update, retain local intent and show current state; never silently overwrite. Card comments and decisions are append-only history with explicit correction records.

### Placement and runner operations

Why waiting shows a prioritized summary and expandable runner reasons, with actionable next steps: enable required runner, wait for capacity, request approval, reconcile target, correct Git declaration. Resources show reserved versus observed, not a single misleading percent. Drain confirms the affected active jobs and prevents new assignments; quarantine is a separate stronger action with audit reason and revocation semantics.

## Loading, failure and offline states

Every route has initial loading, empty-authorized, no-access/not-found, stale-data, partial-provider-failure and retry states. Keep the last authorized snapshot only with a visible updated-at badge. Unauthorized membership change clears affected data immediately. Global shell remains usable if memory or one workspace DB fails.

Use NewUI `DataState`/`EmptyState`/`Skeleton` for these states while Brain's typed Governor client controls authorization, freshness and command receipts. NewUI's generic optimistic collection updates must never mark an approval approved, a target effect applied, or a card Done before server authority confirms it. Cache keys include organization/workspace and authorization generation; switching/revoking scope cancels requests and clears protected state. Do not adopt NewUI's Frappe-specific `/resource` client or its IndexedDB cache for Brain data.

PWA caches versioned static assets only by default. Do not cache private API responses, approval drafts or tokens in a service worker. Offline mode offers a static shell/explanation and previously permitted nonsensitive reference content only when explicitly configured. Mutating decisions are never queued offline. Browser reconnect refreshes authorization and target state before enabling effects. Service-worker update prompts avoid discarding a decision note, and old API clients receive a clear upgrade-required state.

Push requires browser support, secure origin, explicit opt-in and revocable subscriptions. Server outbox produces minimal notifications with no secrets/client PII. Unsupported/denied push falls back to in-app inbox and optional configured channel. Do not promise native periodic background execution, fingerprint behavior or widgets from a PWA.

## Accessibility, localization and responsive acceptance

Target WCAG 2.2 AA: semantic landmarks, labeled fields, correct dialog focus/trap/restore, keyboard reachability, reduced motion, contrast, error association and screen-reader status summaries. Announce meaningful state changes in a polite live region; never announce every streamed token. Charts need text summaries/table alternatives; status never relies on color alone. Virtualized tables need accessible counts/row indices and a paginated alternative if required by assistive technology. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

Prepare English/French message keys, long labels, Unicode content, RTL-safe layout primitives and timezone formatting. Human timestamps show local time plus unambiguous absolute tooltip; approvals show server-derived remaining time. DST is never approximated by the client clock. Reduced-motion disables animated charts/auto-scrolling transitions.

Acceptance captures real workflows at exactly 390/768/1440 px in light and dark, keyboard only and reduced motion. Browser checks include mobile list → detail → approve/reject → Back, stale approval during review, network timeout after decision commit, denied capability controls, log stream backpressure and board conflict. Do not silently regenerate visual baselines. Static screenshots supplement behavior tests, never replace them.
