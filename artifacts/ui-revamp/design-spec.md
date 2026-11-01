# Keyrus Brain UI revamp design specification

## Product anatomy

The shell remains NewUI `AppShell`: Today, Work, Activity, Approvals and Knowledge are primary; Administration stays in account/admin navigation; TV routes remain outside the shell. A page has one h1, one concise task subtitle and one visually primary action. Refresh is secondary and does not compete with the task action.

Screens intentionally use different structures:

- **Attention and decisions:** prioritized queue + readable preview/detail; effect, evidence and next action precede digests.
- **Work planning and launch:** guided composer + substantial proposal/configurator canvas; AI proposal and confirmed work are visibly distinct.
- **Execution:** status/filter strip + wide run collection; run detail and sessions use timeline/activity structures rather than tables.
- **Resources and catalogs:** searchable collection + selected detail, with provenance and scope adjacent to actions.
- **Operations:** fleet cards, capacity/reservation facts and freshness; independent state axes remain separate.
- **Administration:** focused journey sections, with destructive controls separated from routine settings.
- **TV:** distance-readable exceptions and freshness, no AppShell, menus or DataTable chrome.

## Typography and spacing

Use NewUI roles and utilities; do not introduce a second font or color scale. `text-heading` remains the shell page title, `text-section` for major regions, `text-base-medium` for row titles, `text-interface` for reading, and `text-caption` for secondary metadata. Counts, durations and capacities use `tabular-nums`. Long human content is constrained to readable measure; operational canvases use available width.

Brain CSS supplies only composition: content grids, queue rows, detail rails, timeline blocks, board fit, TV sizing and state spacing. Desktop operational layouts use two or three purposeful columns; narrative forms have a bounded reading column. At 768px secondary rails move below primary content; at 390px all content is one column and list/detail navigation exposes Back. No mobile-only navigation implementation.

## Surfaces and hierarchy

- Page canvas: NewUI gray surface.
- One elevated surface for a genuinely interactive group; inset surfaces only for nested evidence or forms.
- Queue collections prefer separators, alignment and selected-state background over card-in-card framing.
- Technical identifiers use `TechnicalDetails`/disclosure and remain copyable; canonical subjects are never discarded.
- Status is label + icon/marker + semantic tone, never color alone. Missing observations render unknown/stale, not healthy.

## Reusable Brain compositions

The smallest shared set is built from confirmed NewUI exports:

- `BrainPage` / `PageStack`: shell header and vertical rhythm.
- `ScreenRegion`: loading, empty, no-access, stale, partial, retry and offline behavior.
- `StatusBadge`: shared state vocabulary and semantic tone.
- `QueueRow`, `WorkspaceSection`, `FactStrip`, `DetailAside`, `Freshness`, `EmptyPreview`: compact domain compositions in `ui/components/Domain.tsx`.
- `EvidenceList`, `ArtifactContent`, `PlacementPanel`, `StructuredOutputView`: existing domain evidence/readability primitives.
- Bounded collections retain real server Previous/Next controls; NewUI `DataTable` is used only where a tabular model improves the task.
- These are layout/domain compositions, not replacements for Button, Dialog, Input, Tabs, DataTable or icons.

## Confirmed pinned NewUI public API evidence

Installed versions: atoms 1.2.0, molecules 2.2.0, organisms 2.1.1, templates 1.1.2, tailwind 1.0.0. Public entrypoints re-export only the package component indexes. Inspected source confirms:

- `AppShell` accepts `brand`, `title`, `navigation: AppSidebarGroup[]`, optional `navigationContent`, `tenant`, `settings`, `account`, `headerActions`, breadcrumbs/actions; its desktop breakpoint is 1024px.
- `PaneLayout` accepts `start`, `end`, `active`, `compactAt`, `startSize`, `minStartSize`, `maxStartSize`, `resizable`; one pane shows below the selected breakpoint.
- `KanbanBoard` supports controlled columns, keyboard Move-to menus, `itemLabel`, `class`, column summaries and custom card bodies. It is not a server-authority mechanism.
- `DataTable` remains client-pagination over supplied rows; server cursors stay outside it.
- `FileUploader` supplies accessible dropzone, accepted/rejected files, size limits and processing state.
- `Stepper` supplies accessible guided-stage navigation.
- `VirtualList` remains the bounded session-feed rendering mechanism.

No Brain source imports NewUI internals. No custom control or palette is introduced.

## State and accessibility rules

- Keep server `asOf` for authority/expiry. Relative browser time is presentation only.
- Revocation and workspace switching clear protected content and abort reads; stale snapshots disable effect actions.
- No optimistic approval, external effect, Done, release activation, runner cleanup or publication.
- Focus rings remain NewUI `focus-ring`; dialogs restore focus. Mobile primary actions have at least 44px hit areas.
- Long EN/FR labels wrap; technical strings break safely; inline-start/end spacing supports RTL; reduced motion disables nonessential transitions.
- 200% zoom must not hide the primary action or create page-level horizontal scrolling. Board/TV exceptions require their own deliberate responsive treatment.

## Performance constraints

Route-lazy screens stay route-lazy. Session updates remain coalesced and virtualized. No chart/editor dependency is added for decorative value. Initial Today JavaScript target is ≤250 KiB gzip; baseline initial index was 75.30 KiB gzip. The final production build measures **75.15 KiB gzip initial JavaScript** and **37.33 KiB gzip CSS**. Browser LCP/INP and network-encoded JavaScript measurements are recorded in `screen-acceptance.md`; they are separate evidence from the bundle measurement.

## Visual evidence

`screenshots/<390|768|1440>-<light|dark>/` contains all 34 final routes. TV routes also have `-1920.png` captures at 1920×1080. `review/` contains the manually inspected contact sheets for all six projects; the 1920 light/dark TV images were inspected at full size. The review checked page containment, task hierarchy, canvas use, readable responsive reflow, empty/detail intent and theme contrast. Browser assertions additionally reject page-level horizontal overflow and uncaught page errors. `accessibility/` contains the separate 200%-zoom RTL capture.
