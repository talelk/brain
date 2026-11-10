# NewUI backlog — improvements deferred to the design-system repo

The Brain UI polish (2026-10-30) is deliberately Brain-side only. The NewUI
packages (`@talelk/newui-*`) are published from the separate monorepo at
`/home/talel/dev/rd2026/newui`; the items below are the fixes that belong
there, with the Brain-side symptom that motivates each. When picked up:
change + changeset + publish in that repo, then bump the exact pins in
`apps/web/package.json` (and the `minimumReleaseAgeExclude` entries for
`@talelk/*` in `pnpm-workspace.yaml`).

1. **AppShell single-source page title.** Brain keeps two title sources — the
   `usePageHeader()` signal fed by `BrainPage` and a regex fallback
   (`titleForLocation`, `apps/web/src/app.tsx:64-67`); the mobile header
   always uses the fallback so desktop/mobile titles can diverge. AppShell
   should accept a plain string *or* accept that `headerActions`-bearing
   shells always render the header bar, and expose the mobile title from the
   same signal.
2. **CommandPalette organism adoption.** `newui-organisms` ships
   `CommandPalette`; Brain hand-rolls `ui/components/GlobalSearch.tsx` from
   Dialog+Combobox instead. The organism needs (a) async result loading, and
   (b) a documented action-entries contract before Brain can switch.
3. **KanbanBoard card-slot API.** Cards render via a single `children` render
   prop; columns have `summary`/`action` slots but cards have no
   header/footer/accent slots, so Brain cannot standardize card anatomy
   (state accent edge, badge row) without duplicating markup per board.
   Add an optional `renderCard` wrapper with `accent`/`meta` regions.
4. **DataState skeleton variants.** Only `rows | cards | chart` exist. Detail
   pages (header + tabs) and stat grids need a `detail` variant and a
   `StatGrid loading` skeleton that matches its cell shape, so
   `ScreenRegion` can pick the right one declaratively.
5. **IconTile atom.** The tinted icon tile (`grid size-10 place-items-center
   rounded-control bg-surface-blue-2 text-ink-blue-8`) is reimplemented four
   times in Brain (`today.tsx`, `workspace.tsx`, `SessionFeed.tsx`) and
   belongs in `newui-atoms` next to Badge, with tone props.

6. **KanbanBoard drag permissions.** Every card lifts and every column accepts
   a drop; `onMove` only reports after the drop. Brain's mission board must
   offer a drag only for transitions the Governor accepts, so it stops the
   press of a card with no legal move in a capture-phase `pointerdown` guard
   (`ui/work/WorkBoard.tsx`) and rejects an illegal drop in `onMove` (the
   controlled card snaps back). Add `canDrag(item)` and
   `canDrop(item, columnId)` so the board can refuse during the gesture and
   show which columns accept the card.

7. **EmptyState guidance slot.** Brain's first-run/no-workspace fallbacks
   hand-roll cards (`app.tsx:197-203`) because `EmptyState` lacks a
   multi-step guidance/children region for setup checklists.

Resolved by the NewUI 1.4/2.4/2.3/1.2 release set and adopted in Brain:
`Dialog position="end"` side sheet (`FormSheet`), `Alert` status role for
non-error tones, `ConfigForm` (schema-driven workflow input), `Stepper`
(guided task entry), `Collapsible` (technical details), `Section`, `StatGrid`
and `EmptyState`. Items 2–5 and 7 are checked against 2.4.0/2.3.0 and still open
(`CommandPalette` has only a `loading` flag, `DataState` has no `detail`
skeleton, `KanbanBoard` has no card slots, `EmptyState` takes no guidance body).

