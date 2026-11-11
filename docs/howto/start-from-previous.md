# Hook: "Start from a previous mission" and reuse suggestions

For the Today box and the new-mission page (issue #69), and for any screen that starts work. Reuse is a Governor read plus one kept-refs list on the plan request; the new-mission files do not need to change for the plan-time suggestions, which already live on the mission's Plan tab.

## Read: what can be reused

`apps/web/src/data/reuse.ts`

- `reuseSearch(workspaceId, goalSentence, missionId?)` returns ranked `ReuseItem`s (query `reuse.search`, `search` = the goal, optional `resourceId` = the mission to exclude and to remember drops for). Each item has `itemRef` (`mission:<id>`, `output:<id>`, `knowledge:<id>`, `play:<id>`, `handoff:<id>`), `title`, `summary`, `lastVerifiedAt`, `usedCount`, `provenance` (mission, verdict digest, evidence digests) and, for a past mission, `startFrom` = `{ title, intent, successCriteria }`.
- Retrieval is SQLite FTS5 (BM25 then recency), deterministic, no model. Unrelated goals return an empty list. Looking never changes `usedCount`.
- `reuseItemHref(workspaceId, item)` gives the link target for an item.

## Start from a previous mission

1. Call `reuseSearch` with what the person typed (or let them pick from a "Recent achieved missions" list built from `kind === "mission"` hits).
2. On choosing a `mission` item, pre-fill `mission.create` from `item.startFrom` (`title`, `intent`, `successCriteria`). Do not copy anything else from the old mission.
3. After `mission.create`, the new mission opens on its Plan tab. That tab runs `reuseSearch(title + intent, missionId)` itself and shows "Brain found N similar past items" before drafting, so the chosen mission is offered again and the person keeps or drops it there. Nothing is attached until they press "Draft the plan with these".

## Write: attaching and removing

- Plan request: `POST /v1/plans { workspaceId, requestId, missionId, reuse: ["mission:...", ...] }` attaches the kept refs through the audited command `mission.reuse.decide` (decision `keep`) and renders them into the planner's `reused` input from the stored attach records. Client text is never forwarded.
- Dropping: command `mission.reuse.decide { missionId, itemRef, decision: "drop" }`. A dropped item is excluded from later suggestions and attaches for that mission. Repeat this beside it is #56.
- Use counts rise only on an attach (`keep`), once per (mission, item).

## What not to do

Reused items are claims with provenance. Never show or treat them as evidence for a criterion.
