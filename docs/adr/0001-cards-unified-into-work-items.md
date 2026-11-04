# 1. Board cards are unified into work items

Date: 2026-11-04
Status: Accepted

## Context

The platform carried two representations of the same concept: Kanban "cards"
(`cards`, `card_comments`, `decisions.card_id`, `board.create/move/comment`,
`CardView`, `workBoard.get`) and work items (`work_items`, `workItem.*`, the
`workItem` state machine). Two representations meant two state machines, two
evidence rules, and divergent read models: the board could show a card as Done
that the work side considered unverified, and decisions recorded on a card
bound to nothing the plan authority could see.

## Decision

Cards are retired. A work item is the only unit the board shows.

- `board.create`, `board.move`, `board.comment` are removed. Work items are
  materialized only through the canonical `objective.create → plan.propose →
  plan.confirm` path, moved with `workItem.transition`, and discussed with
  `workItem.comment`.
- Board state is work-item state (`backlog → ready → in-progress → review →
  done`, with `blocked`/`abandoned` reachable). The old card states map:
  `to-decide → backlog`, `todo → ready`, `verifying → review`.
- Done still requires verified evidence covering every criterion — now enforced
  once, in the work module.
- `board.get` returns one `BoardView` projection (objectives, work items,
  execution links). `workBoard.get` is removed; `WorkBoardView` is renamed
  `BoardView`.
- Decisions bind to work items: `decision.record` carries `workItemId`; the
  `decisions` table column is `work_item_id`.
- A dedicated `modules/board/` owns the read projection and the decision
  surface; the command funnel routes `decision.record` there and delegates
  work-item commands to `modules/work/`.
- The `cards` and `card_comments` tables are dropped from the workspace
  schema; live databases are repaired in place, not reset.

## Consequences

- One state machine, one evidence rule, one board read model. Screens that
  judge work (board, decisions, delivery) bind to the same item and version.
- The old "record Go decision" shortcut on a delivery dossier was removed:
  it bound decisions to dossier ids that were never work items. Decisions are
  recorded from the decision register against a real work item.
- Existing deployments need a one-time in-place schema repair (column rename,
  table drops, digest realignment). No historical card data is preserved —
  the implementation policy waives migration of prior card rows; the repair
  makes the live schema match the current target.
- Contradicts nothing in the glossary; it completes it. `GLOSSARY.md` already
  defines the work item as "the unit the board shows" and lists *card* among
  the avoided synonyms.
