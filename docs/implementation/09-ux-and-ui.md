# 09 — Product experience and UI implementation contract

## Product principle

Design for three human decisions: what needs attention, what is happening, and what is safe to authorize. The default screen is a prioritized work list with a clear next action and freshness, not a wall of charts. Every status links to its evidence or blocker. Technical identifiers/digests are available in details; ordinary users see task, workspace, target, reason and next action first.

Use [NewUI](https://talelk.github.io/newui/) as the UI foundation. Its semantic tokens, public atomic packages and templates establish Brain's visual system. The following task flows remain Brain-owned. Document 16 defines the integration and component map; it replaces the previous proposal to construct a parallel Solid/Zag kit. Validate the composed workflows with operators before broadening the surface.

## Information architecture

Use five primary navigation areas: **Today, Work, Runs, Approvals and Knowledge**. Workspace selection scopes them. Work includes board/decisions and Support/SRE/Delivery tabs; Runs has jobs/sessions/runners tabs and one shared detail composition for summary, attempts, timeline, evidence and placement. Knowledge includes tools. Bridge is a Today view. Settings lives in the account menu; TV has a dedicated kiosk entry. This groups the complete feature set without removing routes or introducing another shell.

The following route index is generated from `contracts/v1/ui-screen-contracts.json`:

<!-- BEGIN GENERATED ROUTES -->
| Route | Main area | Primary task | Essential content |
|---|---|---|---|
| `/today` | today | Handle prioritized work and return to the originating list | priority, workspace, task, reason, freshness |
| `/bridge` | today | Handle prioritized work and return to the originating list | workspace, health, attention, freshness |
| `/w/:id/overview` | work | Review workspace work and pack details | state, outcomes, pending, connectivity |
| `/w/:id/board` | work | Review workspace work and pack details | title, state, criteria, evidence |
| `/w/:id/decisions` | work | Review workspace work and pack details | decision, actor, note, time |
| `/approvals` | approvals | Review exact proposed effects and recover submitted decisions | action, workspace, target, expiry, evidence |
| `/approvals/:id` | approvals | Review exact proposed effects and recover submitted decisions | exactContent, precondition, subjectDigest, history |
| `/jobs/:id` | runs | Inspect a run, its attempts, events and evidence | state, attempts, blocker, evidence |
| `/runners` | runs | Inspect a run, its attempts, events and evidence | group, trust, health, capacity, freshness |
| `/runners/:id` | runs | Inspect a run, its attempts, events and evidence | capabilities, attempts, reservations |
| `/sessions/:id` | runs | Inspect a run, its attempts, events and evidence | task, tools, usage, timeline |
| `/w/:id/support` | work | Review workspace work and pack details | priority, ticket, state, sla |
| `/tickets/:id` | work | Review workspace work and pack details | body, draft, evidence, approval |
| `/w/:id/sre` | work | Review workspace work and pack details | severity, target, state, freshness |
| `/incidents/:id` | work | Review workspace work and pack details | observations, remediation, evidence |
| `/w/:id/delivery` | work | Review workspace work and pack details | source, criteria, risks, evidence |
| `/w/:id/knowledge` | knowledge | Find scoped facts and inspect trusted capabilities | source, scope, freshness, review |
| `/tools` | knowledge | Find scoped facts and inspect trusted capabilities | name, state, effect, release, evidence |
| `/settings` | settings | Manage explicitly authorized administration | members, policy, budget, audit, health |
| `/tv/support` | tv | Read scoped redacted monitoring | aggregateStatus, freshness |
| `/tv/sre` | tv | Read scoped redacted monitoring | aggregateStatus, freshness |
| `/w/:id/runs` | runs | Inspect a run, its attempts, events and evidence | jobs, sessions, runners |
| `/w/:id/agents` | work | Inspect active agent and workflow definitions and dispatch schema-validated inputs | release, instructions, engine, limits |
| `/w/:id/workflows` | work | Inspect active agent and workflow definitions and dispatch schema-validated inputs | release, input-schema, engine, dependencies |
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
