# 21 — NewUI recipes, screen data and interaction oracles

## Public API recipes and tested recovery controller

[BrainRecipes.tsx](../../examples/v1/web/BrainRecipes.tsx) is a reference composition derived from the reviewed NewUI source. [ui-screen-contracts.json](../../contracts/v1/ui-screen-contracts.json) supplies route/query/action/column/state ownership. The installed product now uses actual Better Auth cookies, authenticator enrollment/recovery and step-up in [Authentication](../../apps/web/src/ui/components/Authentication.tsx) and [ApprovalReview](../../apps/web/src/ui/components/ApprovalReview.tsx). Its selected NewUI cohort builds and typechecks; actual browser acceptance remains blocked in this execution environment. The reference framework-independent `approval-controller.ts` tests lost response → unknown → checking → confirmed, repeated unknown checks, duplicate-submit denial, immutable key/note binding and stale/denied review. “Check decision” calls the explicit decision-status endpoint; confirmed means the human decision was recorded. It never marks the target effect applied.

Use NewUI rendered components where their public props support the task. Its reviewed DataTable owns client pagination/search over supplied rows; it is not a remote cursor table. Fetch a bounded Governor page, render it with table search hidden, and place explicit server Next/Previous controls outside the table. Set `selectable={false}` for approval/effect lists: no bulk production approval. Do not feed a claimed total count to an invented prop or load all history to make client pagination work.

`AppShell` requires `brand`, `title` and `children`; `navigation` is an `AppSidebarGroup[]`, while `navigationContent` accepts custom JSX/render content. `tenant`, `settings`, `account`, `headerActions` and controlled collapse are optional public inputs. `Dialog.Root` takes `open`/`onOpenChange`; `Dialog.Content` and Header/Title/Description/Footer own focus and semantics. Button uses `loading`, `disabled`, `onClick`, `type` and supported sizing. Avoid guessed Radix/React/React Query props. Do not bypass NewUI's public entrypoint to reach its internal Zag hooks.

## Shared screen contract

All routes render from a typed QueryResponse plus explicit request status. Use an organization/workspace/auth-generation cache key; abort and clear on auth change. Date text uses server `asOf`, browser locale and an absolute timestamp tooltip; never compute authority expiry from the browser clock alone. Initial state is skeleton; a loaded authorized empty list gets a task-specific explanation/action. A 403/404 clears private content. Server failure can retain the last authorized snapshot with a stale label and refresh control, but effect actions require fresh revalidation.

The default screen stays a task list. On desktop, task summary and detail share a PaneLayout; on 390 px, open detail as a full page with a visible Back action and saved list filter/scroll. Exactly one nav system becomes the mobile modal drawer at the library breakpoint. Do not hide the only action inside a CSS-hidden desktop region. Dense 28 px controls are allowed for mouse views; primary touch actions have at least 44 px hit areas.

## Critical workflow oracles

| Flow | Fixture state and action | Required visible result and server assertion |
|---|---|---|
| Today triage | Expiring approval, blocked job, urgent incident; open each | Priority and reason text, correct scoped detail, Back returns to same row/filter; no invented global count |
| Approval review | Exact proposed note/diff, current target, independent evidence | Main action sentence, target/environment, exact content, expiry and required evidence visible before approval |
| Stale review | Target subject/version changes while dialog open | Submission disabled or 409 revalidation; note preserved; current/new proposal clearly shown; old digest cannot decide |
| Step-up | Approve → TOTP → response timeout after commit | Recover using the original key and decision-status endpoint; one human decision, no duplicate toast or automatic new mutation |
| Unknown effect | Job outcome unknown; select Reconcile | Read-only request receipt; no Retry button until authoritative reconciliation; guard remains for unknown/conflicting |
| Session | 10,000 events, scroll away from bottom, reconnect gap | Grouped tools, bounded mounted nodes, preserved selection/scroll, new-event counter, reset snapshot without duplicate authority events |
| Board conflict | Two clients move version 7 | First change accepted, second conflict shows version 8 and retained intent; no silent overwrite; Done still requires verified evidence |
| Runner control | Busy runner, then Drain and Quarantine | Drain blocks new assignments while old job remains; quarantine shows stop/revocation pending until acknowledgment, not immediate fake cleanup |
| Workspace revoke | Open private detail then revoke membership | Active request aborted, cached body cleared, stream closes, Back cannot reveal cached private text |
| Offline/update | Unsaved human note, disconnect, new service worker | No queued approval; keep note in memory while page stays open, explicit reload confirmation; revalidate after reconnect |

Browser fixture facts come from a deterministic seeded Governor adapter for component tests and the actual Governor for end-to-end tests. Component fixtures cannot pass API authorization or full workflow gates. Use semantic role/name locators, not implementation-only IDs, and web-first waits tied to authoritative events. Cover all rows at 390/768/1440, both themes; keyboard/focus, reduced motion, 200% zoom, long French labels and RTL. Review screenshots without auto-updating them. Numeric performance budgets remain those in document 10 and require real measurements.

## Page inventory completion

Screen contracts bind every route in document 09 to its needed query and actions. A planned route with no current typed query is recorded as a feature extension to implement in its owning pack; it must not ship mock data under an operational label. Support/SRE/delivery/knowledge/tools/settings need pack-specific typed read models before their tasks pass. Define those remote/business payloads in versioned feature schema files, generate DTOs and register handlers; do not overload generic platform health or reuse an unrelated snapshot type.

The required pack read models now exist in the canonical schema: `TicketSummary/TicketDetail`, `IncidentSummary/IncidentDetail`, `DeliveryDossier`, `ToolCatalogEntry`, `DecisionHistoryEntry`, `MemberGrantView` and `AuditEntry`. Their query variants are registered with typed responses. The owning resource supplies stable IDs, versions where mutable, provenance/freshness and linked evidence. Server-derived action hints may be added as typed presentation fields; commands always reauthorize. Query list filters/pagination use the shared contract in document 19, with pack-specific state enums. Handlers are owned by T31/T40–T44/T48; task completion requires all route/query bindings in the screen contract to resolve against real data.
