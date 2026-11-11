# 14. Library is a primary place that holds documents, knowledge, Plays and tools

Date: 2026-11-11
Status: Accepted (issue #73)

Knowledge sat in "More", Plays was a primary area of its own, and the Review inbox lived under Knowledge, so the things Brain can reuse were spread over three places and nobody saw one total. The capitalization loop (finish a mission, approve the write-up, get it offered next time) needs one visible home.

**Decision.** The primary areas are Today, Missions, Live, Logs, Outputs, **Library** and Schedules. Library replaces the former Plays entry (the count of primary entries stays at seven) and takes Knowledge out of "More". Inside it, one shared tab bar offers Overview, Plays, Knowledge, Documents, Tools and the Review inbox, each with an exact count where counting makes sense.

**Routes do not move.** `/w/:id/plays`, `/w/:id/knowledge` (with `?tab=documents|tools`), `/w/:id/knowledge/review`, the Support and Incident Play views and the Studio keep their routes and declare `area: "library"` in `ui-screen-contracts.json`, so the navigation highlights Library on all of them. The new route is `/w/:id/library`. There are no redirects or aliases (AGENTS.md).

**Counts are exact.** `library.summary` counts in the database: awaiting review (knowledge write-ups awaiting a decision, quarantined tool candidates, and later proposed Plays), published knowledge, active documents, Plays of the active release and tools in the catalog. The client never counts a paginated list.

**Defaults on.** Reuse suggestions, capitalization and the review inbox need no switch; the Library says so in one sentence. Anything can be withdrawn from search (ADR 0007).

**Save as knowledge.** Saving a result as knowledge adds a document and then reads it back: "searchable by agents now" appears only when its text was extracted; an unreadable file type is stored and says plainly that agents cannot search it.

Rejected: a five-area layout that merges Logs into Live (large churn in other tracks' screens); moving routes under `/library/...` (breaks deep links and the many specs that use them).
