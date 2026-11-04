# Screen descriptions

What every Brain screen shows, who can act on it, and which commands it can issue.
The authority for this document is `contracts/v1/ui-screen-contracts.json`; the route
index `apps/web/src/routes/index.gen.ts` is generated from it and must not be edited
by hand. For workflow behavior behind the screens, read the
[functional specification](functional-spec.md); for step-by-step guides, `docs/howto/`.

## Global conventions

Every screen renders through the same NewUI foundation and supports the same states:
`loading`, `empty-authorized`, `ready`, `no-access`, `stale`, `partial-failure`,
`retry`, `offline`. List data is snapshot-based with an explicit as-of freshness
stamp and periodic refresh; a stale snapshot is shown and labeled, never silently
dropped. Viewports are 390, 768 and 1440 pixels; themes are light and dark.
Authorization is evaluated server-side per command — a screen may be visible while
its action buttons are unavailable to the current role.

Primary navigation has six areas: **Today**, **Live**, **Work**, **Approvals**,
**Knowledge** and **Administration**. Area navigation adds contextual entries under
each; entries marked `adminOnly`, `organizationOnly` or `identityOnly` appear only
for principals who hold that authority. Deep links carry state: the Live console,
Logs and Runs index all keep their filters and selection in the URL, so a link
shared from another screen restores the same view.

The execution group is the product's center of gravity. When sessions or runs are
active, **Live** is where the application lands.

## Today group

### Today — `/today`

Personal prioritized queue. Each item shows priority, originating workspace, task,
the **reason** it surfaced, and freshness, and links to its resource: an approval, a
run, an incident, the support SLA view, or a decision. Primary action: **Start a
task**, which opens Start work. Refreshes about every 15 seconds.

### Bridge — `/bridge`

Cross-workspace status view: workspace health, attention items and freshness, with
workspace update and control actions for authorized principals. Use it to see where
attention is needed without opening each workspace.

## Live group (execution)

### Live console — `/w/:id/live`

The product's primary screen. A three-pane workspace: a resizable sessions-and-runs
rail on the left, the live console in the center (which splits against its record
inspection pane), and outputs plus contextual inspection on the right. Pane widths
and the split arrangement persist per workspace; below the `lg` breakpoint the panes
stack and the resizers step aside.

The center pane is one selected session: a toolbar carrying task, engine, usage and
context state, over the transcript feed. The feed seeds from the session's head and
hydrates bounded history; severity and emitter filters reshape the whole transcript
and re-hydrate it. Actions: **Steer** (queue guidance delivered at the next turn
boundary) and **Stop** (aborts through the cancellation path). Restarting a session
dispatches through Start work, which validates the workflow input schema and carries
the work item as entry origin — the console never blind-dispatches a blank catalog.

The selected session and the execution filters live in this route's URL, so
returning from approvals, evidence or a work item restores the console exactly.

### Live session — `/sessions/:id`

The workspace-free deep link into the same three-pane console. Active versus
historical is state and available controls, never a second layout. Switching
sessions from here navigates within this route and keeps the filters.

### Logs — `/w/:id/logs`

The Log Explorer: an independent, permanently accessible view over the unified
execution stream, with its own URL. Live tail with pause/resume and an unread
counter, source and severity filters, full-text search across authorized retained
logs, correlation jumps between related contexts, tool-call grouping, Readable and
Raw modes, cross-attempt comparison, bounded sanitized export and error navigation.
Filters persist in the URL for deep links. This screen issues no mutations.

### Outputs — `/w/:id/outputs`

The Output Browser: browse every authorized generated artifact with previews,
version history and diffs. Filters and the selected artifact persist in the URL.
Comparison picks hand off to the workspace-free `/artifacts/:id` route, where the
diff query is declared. It is a primary experience, not a tab of run detail.

### Artifact — `/artifacts/:id`

One artifact, workspace-free: preview, metadata, independent verification status,
version history, and — via the `?left=&right=` deep link other surfaces build — the
diff between two versions. Session state never lives here.

### Runs — `/w/:id/runs`

The run index: searchable, cursor-paged runs with state and view filters, active by
default. Because sessions now live in the console rail and runners have their own
screen, this index stays a single list; when `live.status` reports active sessions
the empty state points to the console instead of claiming nothing is running.
Dispatch opens Start work.

### Run inspector — `/jobs/:id`

One run's full story: current state and attempts, the blocker explanation, structured
step outputs (Summary), engine events including governed tool-call events (Timeline),
and the independent validation verdict with artifact links (Evidence). Actions:
**Cancel run** and **Reconcile** for `outcome_unknown` attempts — reconcile records
the observed target state before any retry. It deliberately does not duplicate the
console, logs or outputs.

### Runners — `/runners`

Runner enrollment list: group, trust, health, capacity and freshness. Actions: drain,
quarantine and runner control.

### Runner detail — `/runners/:id`

One runner's capabilities, attempts and reservations, with the same control actions
(functional spec AF-06).

## Work group

### Overview — `/w/:id/overview`

Workspace state at a glance: work outcomes, pending items, connectivity, plus the
setup checklist that guides first-time configuration. Entry point for dispatching
work.

### Plans — `/w/:id/plans`

Turn an intention into reviewed, versioned work. **Ask Brain for a plan** takes a
title, an intent and success criteria, dispatches the release's plan-guide agent
through the governed runner path and validates the proposal independently; nothing
enters the board before a human confirms. The proposal is editable in place — task
titles, criteria and dependencies — and confirming materializes exactly one
plan version into work items and dependencies. Regenerating produces a new
inert proposal; confirming a new revision retains unchanged work and its history.

### Board — `/w/:id/board`

Kanban for work items confirmed from a plan: Backlog, Ready, In Progress, Blocked,
Review, Done. Each item carries title, criteria, assignment, dependencies, next action
and evidence links. Moves are version-checked: a stale expected version conflicts
and shows the current version instead of overwriting. Done always requires verified
evidence covering every criterion — model text never closes work. The detail
dialog starts tasks with prefilled context, attaches verified evidence bundles and
records comments; execution runs stay linked to the originating work item.

### Tasks (Start work) — `/w/:id/workflows`

The task catalog: active workflows with their release, input schema, engine
requirements and dependencies. Selecting a workflow opens the schema-driven input
form; **Review task** validates inputs, then **Start task** durably starts the run
(prepare → review → start; see functional spec UF-02). Example presets can prefill
forms.

### Schedules — `/w/:id/schedules`

One durable scheduler for work items and released workflows. Create an automation
with a title, a target (workflow id or work item scheduled start) and a trigger:
recurring cron with an IANA timezone, one-off delayed, or manual. Overlap
(skip / queue-one) and misfire (skip / coalesce) policies govern bursts and paused
windows. The screen shows server-derived next occurrences (the browser never
computes schedules), pause / resume / Run now controls and the occurrence history
with run links. Occurrence identity is (automation, revision, instant), so
restarts and lost responses cannot duplicate a run; revising creates a new
revision without rewriting past occurrences.

### Resources — `/w/:id/resources`

Workspace documents: upload, revise, associate and delete. The library lists
documents with versions, size and media type, supports search and pagination, and
previews the media types Brain renders inline. Associations bind a document to a
work item, run or artifact, and indexing state is shown per document. Uploading and
revising produce immutable versions; deleting revokes access rather than rewriting
history.

### Support — `/w/:id/support`

Ticket list with priority, ticket state and SLA summary; start tasks on tickets.

### Ticket detail — `/tickets/:id`

Ticket body, response draft, evidence, and any related approval. **Start a task for
this item** prefills the form from the ticket. Starter support tasks produce drafts
only — nothing is ever sent to the customer from Brain.

### Incidents — `/w/:id/sre`

Incident list with severity, target, state and freshness; start investigation tasks.

### Incident detail — `/incidents/:id`

Observations, proposed remediation, evidence, and the run history started against
this incident (each run links back; see functional spec UF-04).

### Delivery — `/w/:id/delivery`

Delivery items with source, criteria, risks and evidence; decisions can be recorded
against them.

### Decisions — `/w/:id/decisions`

The workspace decision log: decision, actor, note, time. **Record decision** writes a
first-class auditable entry (`decision.record`), separate from effect approvals.

### Agents — `/w/:id/agents`

Agent definitions in the active release: pinned instructions, permitted engines and
requirements, limits (turns, tokens, cost), tool allowlist. Dispatch entry point.
Shown in the administration area navigation; read-only here — agents change through
releases (functional spec AF-04).

## Approvals group

### Approvals — `/approvals`

List of pending approval requests: action, workspace, target, expiry, evidence.
The list itself has no actions — decisions happen only on the review page.

### Approval review — `/approvals/:id`

The exact proposed effect: exact content, precondition, subject digest, and decision
history. Deciding (approve/reject) is human-only, one-use, made on this page; with
required 2FA it needs a current session plus TOTP. Also hosts **revoke** (for
authorized roles) and **decision-status recovery** when a submitted decision was not
observed. Authors cannot approve their own effects (functional spec UF-06).

## Knowledge group

### Knowledge — `/w/:id/knowledge`

Workspace memory and trusted capabilities in one view: search published knowledge by
source, scope, freshness and review status, alongside capability candidates with
their tests and release gate, and capitalization runs with provenance. Authorized
roles (workspace-lead, security-admin) can **publish** and **revoke** memory entries,
**run** capitalization, **review** candidates and **publish** tools (functional spec
AF-08). Publishing requires a reviewer principal distinct from the publisher.

### Tool catalog — `/tools`

Governed tools in the active release: name, state, effect class (`read`, `write`,
`privileged`), release digest, evidence. `tool.propose` and `tool.publish` gate
availability (tool-publisher role). Agent tool calls cross the governed broker only;
this catalog shows what is pinned and allowed.

### Studio — `/studio/:kind`

Create a configuration draft without editing YAML by hand. Pick a kind — Workflow,
Agent or a reviewed definition — and start from visual jobs, the agent contract, or
restricted YAML. Lists existing drafts with their validation state. Publication never
edits the active release directly.

### Configuration Studio — `/studio/:kind/:draftId`

Edit, test, review and publish one immutable definition: the definition editor,
structural diagnostics, a diff against the current revision, impact analysis, and
the validation and publication panel. Publication requires a passing current
revision and a verified configuration write binding — created and verified under
Administration → Integrations — and produces an exact Git commit that is activated
separately.

## Administration

### Administration — `/settings`

Tabbed administration surface. The default tab is Security; tab visibility follows
authority, and unauthorized tabs simply do not appear.

| Tab | Route | Who sees it | Content and actions |
|---|---|---|---|
| Setup | `?tab=setup` | org admin | Connect the model: API URL and exact model ID, **Test connection and start runners**, automatic task/validator runner pairing, installation test in the setup checklist (AF-02) |
| Security | `?tab=security` | everyone | Password change, 2FA enrollment/disable, push notification controls |
| Releases | `?tab=release` | org admin | Release onboarding — select an immutable staged release, inspect its complete contents, activate explicitly — plus effective-configuration tracing of where each active value comes from (AF-04) |
| Access | `?tab=members` | admin | Workspace members with roles granted per principal and a recorded reason; grant and revoke. Organization membership alone does not grant workspace content (AF-03) |
| People | `?tab=people` | identity admin | Organization members: role grant and revoke, suspend and reactivate, session revocation |
| Invitations | `?tab=invitations` | identity admin | Create, cancel and retry organization invitations |
| Authentication | `?tab=policy` | identity admin | Organization authentication policy |
| Health | `?tab=health` | org admin | Platform health snapshot, degraded alerts (pending outbox with ages), the append-only workspace audit trail, and the redacted diagnostics download (AF-07) |

### Integrations — `/administration/integrations`

Connect Git providers and bind repositories to workspaces. Shows connections with
provider, organization, permissions, webhook and verification status, plus the
repository bindings and proposals they produced. Actions: **connect** (name,
repository URL, username, token), **verify** (an asynchronous probe whose result
lands back on this screen) and **bind** a repository as configuration or project,
read or write. The binding created here is what the Configuration Studio requires
before it can publish.

### Accept invitation — `/accept-invitation/:id`

The landing page for an invited account: verify the email, sign up, and explicitly
accept organization membership. Nothing is joined silently — acceptance is an
explicit action on this page.

## TV group

### Support board — `/tv/support`, SRE board — `/tv/sre`

Read-only kiosk views for wall displays: aggregate ticket/incident status and
freshness. The kiosk principal is explicitly redacted — aggregate status only, never
private ticket bodies, and no mutation actions exist on these screens.
