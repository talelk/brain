# Screen descriptions

What every Brain screen shows, who can act on it, and which commands it can issue.
The authority for this document is `contracts/v1/ui-screen-contracts.json`; the route
index `apps/web/src/routes/index.gen.ts` is generated from it and must not be edited
by hand. For workflow behavior behind the screens, read the
[functional specification](functional-spec.md); for step-by-step guides, `docs/howto/`.

## Global conventions

Every screen renders through the same foundation and supports the same states:
`loading`, `empty-authorized`, `ready`, `no-access`, `stale`, `partial-failure`,
`retry`, `offline`. List data is snapshot-based with an explicit as-of freshness
stamp and periodic refresh; a stale snapshot is shown and labeled, never silently
dropped. Viewports are 390, 768 and 1440 pixels; themes are light and dark.
Authorization is evaluated server-side per command — a screen may be visible while
its action buttons are unavailable to the current role.

Primary navigation: **Today**, **Work**, **Activity**, **Approvals**, **Knowledge**.
Area navigation adds contextual entries; those marked admin/organization-only appear
only for authorized principals. Global search finds runs, approvals, agents and
workflows by id.

## Today group

### Today — `/today`

Personal prioritized queue. Each item shows priority, originating workspace, task,
the **reason** it surfaced, and freshness, and links to its resource: an approval, a
run, an incident, the support SLA view, or a decision. Primary action: **Start a
task**, which opens Start work. Refreshes about every 15 seconds.

### Bridge — `/bridge`

Read-only cross-workspace status view: workspace health, attention items, freshness.
No mutation actions. Use it to see where attention is needed without opening each
workspace.

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
Review, Done. Cards carry title, criteria, assignment, dependencies, next action
and evidence links. Moves are version-checked: a stale expected version conflicts
and shows the current version instead of overwriting. Done always requires verified
evidence covering every criterion — model text never closes work. The detail
dialog starts tasks with prefilled context, attaches verified evidence bundles and
records comments; execution runs stay linked to the originating work item.

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

### Tasks (Start work) — `/w/:id/workflows`

The task catalog: active workflows with their release, input schema, engine
requirements and dependencies. Selecting a workflow opens the schema-driven input
form; **Review task** validates inputs, then **Start task** durably starts the run
(prepare → review → start; see functional spec UF-02). Example presets can prefill
forms.

### Agents — `/w/:id/agents`

Agent definitions in the active release: pinned instructions, permitted engines and
requirements, limits (turns, tokens, cost), tool allowlist. Dispatch entry point.
Shown in the administration area navigation; read-only here — agents change through
releases (functional spec AF-04).

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

## Runs group

### Activity — `/w/:id/runs`

Workspace activity in three lists: jobs (runs), live sessions, runners. Global search
lives in this area.

### Run detail — `/jobs/:id`

One run's full story: current state and attempts, the blocker explanation, structured
step outputs (Summary), engine events including governed tool-call events (Timeline),
and the independent validation verdict with artifact links (Evidence). Actions:
**Cancel run** and **Reconcile** (for `outcome_unknown` attempts; reconcile recorded
target state before any retry).

### Live session — `/sessions/:id`

A live agent session: task, tool calls, usage, timeline. Actions: **Steer** (send
guidance) and **Stop**.

### Runners — `/runners`

Runner enrollment list: group, trust, health, capacity, freshness. Administration
area entry. Actions: drain and quarantine.

### Runner detail — `/runners/:id`

One runner's capabilities, attempts and reservations, with drain and quarantine
actions (functional spec AF-06).

## Knowledge group

### Knowledge — `/w/:id/knowledge`

Workspace memory: search published knowledge by source, scope, freshness and review
status. Authorized roles (workspace-lead, security-admin) can **publish** and
**revoke** memory entries (functional spec AF-08).

### Tool catalog — `/tools`

Governed tools in the active release: name, state, effect class (`read`, `write`,
`privileged`), release digest, evidence. `tool.propose` and `tool.publish` gate
availability (tool-publisher role). Agent tool calls cross the governed broker only;
this catalog shows what is pinned and allowed.

## Administration — `/settings`

Tabbed administration surface; tab visibility follows role (setup, releases, members
and health are admin/organization-only; security and integrations are available to
every user for their own account).

| Tab | Content and actions |
|---|---|
| Setup | Connect the model: API URL and exact model ID, **Test connection and start runners**, automatic task/validator runner pairing, installation test in the setup checklist (AF-02) |
| Security | Password change, 2FA enrollment/disable, push notification controls |
| Integrations | External links (Memory UI, external admin UI); opened with `noopener noreferrer`, Brain forwards no credentials |
| Members | Workspace members with roles granted per principal with a recorded reason; grant and revoke (AF-03) |
| Releases | Release onboarding — select an immutable staged release, inspect its complete contents, activate explicitly — plus effective-configuration tracing of where each active value comes from (AF-04) |
| Health | Platform health snapshot, degraded alerts (pending outbox with ages), the append-only workspace audit trail, and the redacted diagnostics download (AF-07) |

## TV group

### Support board — `/tv/support`, SRE board — `/tv/sre`

Read-only kiosk views for wall displays: aggregate ticket/incident status and
freshness. The kiosk principal is explicitly redacted — aggregate status only, never
private ticket bodies, and no mutation actions exist on these screens.
