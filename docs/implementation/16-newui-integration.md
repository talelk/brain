# 16 — NewUI integration contract

## Decision and reviewed source

[NewUI](https://talelk.github.io/newui/) is the required UI foundation for Brain Web, Mobile PWA and TV. This decision supersedes the initial custom primitive kit and palette in this pack. Use the public packages and their contracts as the starting point for implementation. Brain supplies domain workflows, Governor clients, authorization-aware state and product compositions.

The documentation site was fetched successfully on 27 October 2026. Its upstream repository and local source checkout were inspected at commit `54bf4d641aa8fcaa909e5b8e29fa24de0e3492e1`. The checkout has unrelated local changes; this review uses committed package manifests/contracts, and none of those local changes is included in Brain. This is source/API review, not a visual browser acceptance run or proof that every package version is published. `contracts/v1/ui-foundation.json` records source paths/hashes, observed versions and the integration gate status.

Authoritative upstream references: [atomic kit](https://github.com/talelk/newui/blob/54bf4d641aa8fcaa909e5b8e29fa24de0e3492e1/spec/kit.md), [visual system](https://github.com/talelk/newui/blob/54bf4d641aa8fcaa909e5b8e29fa24de0e3492e1/spec/visual-system.md), [starter](https://github.com/talelk/newui/tree/54bf4d641aa8fcaa909e5b8e29fa24de0e3492e1/apps/starter), and the selected component's contract/source at the same revision. Older NewUI notes using `@newui/ui`, `apps/web/src/ui`, `AppLayout`, or separate DesktopShell/MobileShell implementations are historical; do not build compatibility layers around them.

## Package selection and ownership

| Public package | Brain use | Ownership rule |
|---|---|---|
| `@talelk/newui-atoms` | Controls, marks, typography, provider, theme controller | Reuse public exports and supported variants |
| `@talelk/newui-molecules` | Forms, overlays, selection, tabs, notices, timeline | Compose interactions without another Zag implementation |
| `@talelk/newui-organisms` | Application regions, tables, lists, board, filters, stats | Use rendered data regions here, not from the headless data package |
| `@talelk/newui-templates` | AppShell, PaneLayout and AuthLayout | One application shell; responsive layouts are template composition |
| `@talelk/newui-tailwind` | Semantic CSS and source integration | Import `style.css` once; no root JavaScript import |
| `@talelk/newui-tokens` | Token metadata when required | Theme values come from NewUI rather than a Brain palette |
| `@talelk/newui-data/query`, `/form` and root helpers | Optional headless query/form/format behavior | Typed Governor adapters and Brain domain semantics remain outside the library |
| `@talelk/newui-icons` | Optional explicit icon components | Follow selected export; avoid bundling an entire icon catalog |
| `@talelk/newui-charts` | Optional SRE/SLA/cost trends | Route-lazy; preserve theme and accessible data fallback |
| `@talelk/newui-editor`, `@talelk/newui-code-editor` | Deferred until an actual editing feature needs them | No default rich-editor/code-editor weight in approval/session views |
| `@talelk/newui-vite` | Optional development tooling only | Frappe proxy/DocType generation are not Brain integration mechanisms |

Select exact published artifacts as a compatible set in T01/T33, recording integrity, source correspondence, peers and license/notice files. Versions differ across packages; do not assign one guessed suite version. If the required artifact is unavailable, use reviewed reproducible package tarballs built from the approved full commit or keep UI integration blocked. A raw Git dependency pointing at a monorepo root is not a substitute for building its packages. No mutable main branch, floating range or symlink to a developer checkout in a release.

## Component map for implementing models

| Brain need | Verified NewUI public surface | Brain-specific work |
|---|---|---|
| Main navigation and workspace/account controls | Templates AppShell; organisms AppSidebar | BrainShell supplies permission-filtered navigation and tenant/workspace slots |
| Approval/ticket list and detail | Templates PaneLayout; organisms DetailHeader | Mobile navigation and immutable selection/review state |
| Sign-in | Templates AuthLayout; organisms AuthCard | Better Auth transport, validation and session lifecycle |
| Ordinary controls | Atoms Button, IconButton, TextInput, Textarea, Checkbox, Switch | Bind typed fields and action states; `Input` is not the selected text-input export |
| Select/search/filter | Molecules Select, Combobox, DateRangePicker; organisms FilterBar | Governor query parameters and scoped search |
| Approval confirmation or mobile review | Molecules Dialog, BottomSheet; atoms Button | ExactActionSummary, step-up and server-bound decision digest |
| Status and progress | Atoms Badge, Progress, KeyValue | Exhaustive domain-state mapping and ResourceMeter composition |
| Loading/empty/failure | Organisms DataState; molecules EmptyState/Alert; atoms Skeleton/ErrorMessage | Typed failure/freshness/permission states and retry policy |
| Jobs, runners, approvals tables | Organisms DataTable; molecules Pagination/ScrollTable | Server pagination/filtering and accessible row actions |
| Long session feed | Organisms VirtualList; molecules Timeline | Bounded event store, stream coalescing, follow/selection behavior |
| Work board | Organisms KanbanBoard | Versioned move commands, keyboard action menu and verified Done gate |
| Notifications | Molecules Toaster/Toast, NotificationItem | One host; scoped event notices and safe review links |
| Evidence and diffs | Atoms/molecules composed into EvidenceList/DiffViewer | Safe escaped rendering, authorized artifact fetch and acceptance links |
| SRE/SLA trends | Charts add-on | Shared typed dataset/freshness and route-lazy loading |

Names identify exports, not interchangeable prop shapes. Inspect the pinned component contract and compile a small usage before writing a page. A token, recipe, registry demo or internal source file is not automatically a public component export. Do not import `/internal` or package-private files, invent AlertDialog/Drawer exports, copy playground shell code, or wrap every primitive merely to rename it.

## Consumer files and build wiring

T33 creates `apps/web/src/index.css`, `apps/web/vite.config.ts`, `apps/web/src/ui/theme.ts`, `apps/web/src/ui/brain.css` and domain compositions under `apps/web/src/ui/components/`. T34 creates `apps/web/src/shell/BrainShell.tsx`, route compositions and Governor data adapters. The Brain UI package imports public NewUI layers and keeps business policy in application/domain modules.

Import `@talelk/newui-tailwind/style.css` once in the application CSS entry. Declare Tailwind scanning for HTML, application TS/TSX and shared Brain compositions; verify package-generated CSS/source behavior for the actual installed layout. Follow NewUI's exported `source` integration where needed instead of depending on pnpm's private store paths. Declare the pinned `lucide-static` build-time dependency in the consuming app so the icon plugin emits utilities, and verify a rendered icon's computed mask in the production browser fixture. A production fixture must render a control, dialog, table and theme switch with emitted styles; a dev-server render alone is insufficient.

Keep one color-scheme owner and an owned lifecycle for its media listeners. Apply the shared UIProvider for RTL/portal configuration and mount one Toaster. Adopt NewUI typography/spacing/status colors. Brain may define domain-specific layout and a documented status-to-token mapping, but it does not redefine global neutral/blue ramps, control recipes or focus styles. NewUI's default is 28 px; use `lg` consistently for page/form/dialog actions and `sm` for compact row/icon actions rather than ad-hoc minimum heights.

Use Vite/Solid/Tailwind versions compatible with the selected artifacts and record the consumer TypeScript/tooling matrix. Upstream's source verification toolchain does not make the pack's local TS 5.9 typecheck proof of NewUI compatibility. Keep chart/editor packages out of the initial route and exclude documentation/Storybook/devtools dependencies from production. Browser development proxy rules target Brain `/v1` and `/api/auth`; runners/MCP clients connect directly to Governor. Never enable a Frappe bench proxy by copying optional tooling defaults.

The required `BrainConfig.spec.ui` and separate `WebBuildConfig` make this decision explicit in configuration. Both reference the exact byte digest of the reviewed foundation manifest. See [the configuration contract](03-configuration-and-workflows.md), [web build profile](../../examples/v1/config/web-build.json) and [consumer Vite/CSS examples](../../examples/v1/web/README.md). Foundation/dependency changes bind at image build and verified release activation; presentation defaults cannot install a library at runtime.

## Data and authorization boundary

NewUI's generic data helpers are optional. The browser's typed Brain client calls the documented query/command/decision endpoints, handles CSRF/session errors and validates response versions. No UI repository connects to SQLite, TencentDB or runner hosts. Do not use `@talelk/newui-data/resource`, DocType hooks, its IndexedDB cache or Frappe websocket transport for Brain records.

The reviewed collection helper supplies optimistic update/remove behavior and list-oriented CRUD. Do not route approval decisions, production effects, verified Done, quarantine or memory/tool publication through arbitrary `update(id, patch)`. Those use explicit Brain commands with idempotency, expected version and server confirmation. A local pending indicator is permissible; optimistic authorization/completion is not. For bounded read-only collections, an adapter may use the helper if it preserves pagination and scope; larger server-cursor views must not fetch every record to satisfy a generic list abstraction.

Cache identity includes organization, workspace, principal authorization generation, query type and filters. Scope switches/revocations cancel old requests, dispose/clear the old provider/cache and refresh authorization. Supplying a new client prop to the same mounted provider is not sufficient where the provider selects its client at mount. Clear sensitive notes/drafts according to policy. SSE remains Brain's bounded durable replay path; it is not replaced by a library's unrelated realtime client. Chart/SLA calculations use the same authorized versioned dataset as tables/exports.

## Adoption and acceptance checklist

T01/T33 record exact package artifacts and compile representative public exports. T33 proves production CSS, light/dark switching, portal/focus, text zoom, touch targets and optional-add-on splitting. T34 proves one AppShell model at 390/768/1440 widths, accessible mobile drawer, workspace change cleanup and list/detail return state. T35/T37 prove server-confirmed approval/Done and optimistic conflict recovery. T49 measures the actual consumer bundle and long-stream behavior.

The installed cohort ships TypeScript/TSX sources rather than declaration-only exports. Brain Web now runs its own actual `typecheck` in the standard verification/build paths. It retains TypeScript `strict: true` and `noUncheckedIndexedAccess`, includes `DOM.Iterable`, and uses `exactOptionalPropertyTypes: false` for this source-consuming project: the installed NewUI packages forward optional props with explicit `undefined` and fail under that additional flag. Governor/contracts/runner/CLI retain the flag. This is the selected current compiler contract, not a claim that vendor source satisfies the stronger optional-property check. Runtime browser acceptance remains separate. `AppShell.navigation` takes `AppSidebarGroup[]`; custom JSX belongs in `navigationContent`.

Use E093/E097 plus existing security/command/cache scenarios. Reuse the same product compositions in isolated fixtures and routes; test loading/empty/error/stale/forbidden states rather than importing a static demo. Capture light/dark baselines deliberately; no automatic update of approved images. If NewUI lacks a required behavior, document the source version, smallest reproduction and proposed upstream fix or domain composition. The library and Governor integration gates remain pending until those tests execute.

If an authorized later task changes NewUI itself, its own repo gates apply (`pnpm css` after tokens, `pnpm api`/`pnpm site` after public API/site changes, and its verification/browser/visual checks). They are not Brain commands and are not required for merely consuming unchanged published packages. This documentation update changes no NewUI source and implements no Brain UI.
