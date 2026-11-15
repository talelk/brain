# 52. The board never moves work to Review or Done, and filters work on the Governor

Status: accepted, 2026-11-15.

The mission board (#43) let a person drag an in-progress card to Review. Spec #90 (stories 59-60) adds a board across missions and says moving a card to Review or Done stays impossible (ADR 0022).

## Decision
1. Neither the drag nor the card's Move-to menu offers Review or Done, on a mission's board or the workspace board. Review comes from a run submitting its evidence; Done needs verified evidence. A refused drag says why. The item's own Move work item form is unchanged and still gates Done.
2. The workspace board is a view of Missions (`/w/:id/board`, ADR 0029), not a fifth place. It reads `workItems.list`, which now takes optional `missionId`, `memberId`, `priority` and `tag`, applied in SQL before the page limit of 100, so older matching work is never hidden behind newer work. Filter options come from the unfiltered read.
3. A mission's Plan tab opens on its board; the timeline is `?view=timeline`.

## Consequences
- A person can no longer drag an in-progress card to Review; sending a card back from Review to In progress stays a plain move.
- A mission's own board reads with `missionId` instead of filtering a workspace page in the browser.
