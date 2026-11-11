# Spec: reuse and capitalization as the core loop, with tools, memory, token metering and context management (track G)

Request (owner, 2026-11-11): add existing research as default features; check and fix tools, memory and capitalization; add a token budget meter and context management; make reuse and capitalization first-class. This spec sits beside `docs/specs/hands-off-product-shell.md` (issues #46-#64) and does not repeat its tickets; where a ticket here extends one, it says so.

## Findings (cited; code read at `talelk/brain@6e4fba5`)

### F1. Existing research: what is already a feature, what is not

| Source | Item | Disposition |
|---|---|---|
| `docs/research/best-product-gap-2026-11.md` gaps 1, 3 | general workflow, planner assumptions | Track A (backlog 1) |
| same, gaps 4, 5 | one result per task, failure reasons | Track B |
| same, gaps 2, 6-12 | first run, trust, queue, cost, repeat, mobile, steer, quality | Tickets #47-#64 |
| `docs/research/agentic-os-gap-analysis.md` G6 Skeptic | reviewer role | #50 |
| same, G4 research provenance | claim basis (verified, measured, inferred, hypothetical) | New: part of the readable knowledge asset (ticket "Readable knowledge assets"); the general workflow's `sources.json` is track A |
| same, G3 data analysis | governed tool for supplied data | New: `csv.query` default tool |
| same, G5 document/deck generation | governed output tool | Not default; needs-triage decision inside the default-tools ticket |
| same, G1 source-watching connectors, G7 estimation content | Play content | Not default; stay Play content per the gap analysis recommendation |
| same, G2 packs vs release-defined Plays | open question Q1 | Not decided here; "Suggest a Play" ticket assumes release-defined Plays and is needs-triage for that reason |
| `agentic-os-usage-analysis.source.md` Example 4 (persist a product-specific acceptance profile) | reusable criteria | New: criteria carried by a proposed Play |
| same, "useful results promoted to scheduled recipes" | repeat | #56 |
| Manus context engineering (best-product file section 1) | filesystem as memory, keep errors in context, reversible compression | New: context manifest and deterministic compaction by reference |

The two `agentic-os-*` files exist only in the main checkout and are untracked; they are cited, not committed here.

### F2. Tools

- The starter release ships one demo tool, `operations.context`, whose script returns a fixed sentence (`examples/v1/starter-release/tools/operations.context/run.sh`), and an evaluator-side `operations.validate`. Four of five starter agents have `"tools": []` (`config/task-guide-agent.yaml`, `plan-guide-agent.yaml`, `support-analyst.yaml`, `diagnostic.yaml`). No default tool reads knowledge, documents or the web.
- The broker is sound (`docs/howto/add-governed-tool.md`: digest-pinned, schema-checked, effect-class permits, sandbox).
- The registry read invents fields: `activeTools()` stamps `createdAt` with the current time on every call, `status` is always `trusted` and `evidence` always `[]` (`apps/governor/src/modules/capabilities/service.ts`, `activeTools`). The page (`apps/web/src/routes/pages/ToolsPage.tsx`, `routes/knowledge.tsx` `ToolsScreen`) shows what exists but not which agents may call a tool, how often it was called or last failed.
- Runner engines treat `maxMicroUsd: 0` as a hard zero in the post-check but as "no cap" when passing the SDK budget (`apps/runner/src/engines/claude.ts` lines 184 and 211; `pi.ts` line 129); every starter agent declares 0 and the policy floor reports 0 for "unbounded" (`configuration/policy-floor.ts`). On a paid endpoint any run with cost above zero fails. Hidden today because local endpoints report zero cost. Not fixed: it is a policy decision (ticket).

### F3. Memory

- Three disconnected stores: workspace documents (`document.upload`, which "Save as knowledge" uses: `apps/web/src/ui/outputs/review-actions.ts` `saveAsKnowledge`), published memory assets (`apps/governor/src/modules/knowledge/memory.ts`, control.db `memory_assets`) and capitalization `knowledge_assets` (`capabilities/service.ts`). Searching memory never sees documents or extracted assets.
- No consumer: the runner builds the engine prompt from instructions plus `step.task` or the run input JSON (`apps/runner/src/supervisor.ts` line 230; `engines/run.ts`). `sessions.context` assembles brief, dependency handoffs, inputs, messages and checkpoint (`apps/governor/src/modules/sessions/service.ts` `context`) but I found no path that places it, or any memory result, in the prompt of a workflow-driven run. Verify first (first step of the context ticket).
- Local search was substring-OR in insertion order. Fixed in this branch: results now rank by distinct matched terms then recency (`memory.ts`, test in `tests/integration/memory.test.ts`). Still open: `sourceTypes` in the query is ignored (the Knowledge page sends chat, skill, wiki, codegraph), results are always `status: "unverified"`, the whole set is held in process memory, and local search always reports `degraded: true` with a "TencentDB not configured" reason (`application/brain.ts` lines ~1018-1024), so a default install looks permanently degraded.

### F4. Capitalization

- Mission close queues one capitalization run (`requestMissionRun`), which writes raw JSON rows into `knowledge_assets` from accepted decisions, verified output (name and digest only), verdict findings and handoff facts (`extractMissionKnowledge`). These show in the review studio under `operationId` "mission-knowledge" as JSON text; provenance is looked up by signature in `operation_observations`, which mission signatures never enter, so provenance is empty (`asset()`).
- The studio lists assets read-only; only capability candidates have review/publish actions (`apps/web/src/ui/studio/CapitalizationStudio.tsx`, `routes/pages/KnowledgeReviewPage.tsx`). No command advances an asset from extracted to reviewed; publishing requires a hand-built `memory.publish` with a content artifact, reviewer and redaction profile. So the loop stops at extracted and nothing is searchable or reused.
- There is no way to turn an achieved mission into a Play, and nothing offers past work when starting new work.
- The glossary rule that a memory publication reviewer differs from the publisher conflicts with a single-owner install; a decision is needed.

### F5. Tokens and context

- Engines already report `inputTokens`, `outputTokens`, `cachedInputTokens`, `microUsd`, `accounting` and `estimated` in `usage` events (`engines/claude.ts` line 208, `pi.ts` line 126). The Governor stores them only inside `attempt_events` and settles `microUsd` only (`missions/budget.ts` `settle`). Tokens are never totalled per attempt, task, mission or workspace; the console feed shows tokens per event (`ui/console/ConsoleFeed.tsx`).
- The mission budget is USD, time and member cap (`MissionBudget`); there is no token ceiling. For local models USD is zero, so the meter in `ui/components/MissionWorkItems.tsx` and `MissionPage.tsx` can never bind. Only the per-session `maxTokens` exists.
- `settle()` sums incremental usage without deduplicating by `usageId`; current engines emit one final total, so it is latent.
- Handoff notes are capped at 6000 characters each (`evidence/handoff.ts`) but a dependent receives all direct handoffs with no aggregate budget, and no record exists of what context a run received.
- Repo-side: no tracked CLAUDE.md; AGENTS.md is about 3 KB but points at `GLOSSARY.md` (18 KB), `IMPLEMENTATION_PROMPT.md` (16 KB), `docs/functional-spec.md` (31 KB) and `docs/implementation/` (about 420 KB, `23-runtime-status.md` alone 50 KB). Nothing measures or caps what a session loads.

## Problem Statement

Brain verifies work well but forgets it. A person who finishes a good mission cannot start the next one from it, an agent about to plan or run never sees what Brain already knows, extracted knowledge sits unreadable and unsearchable, and cost is visible only in dollars that are zero for local models. Nobody can see how many tokens a task, mission or the workspace used, or what context an agent was given. Developers working on this repo have no measure of how much documentation each agent session loads.

## Solution

Make reuse the central loop, and meter and manage context:

- Before planning or starting work, Brain searches past missions, results, published knowledge, Plays and handoffs and proposes them; the planner and agents receive the chosen items as context with provenance.
- Every finished, verified mission proposes a readable knowledge asset and, on request, a Play, into a Library review inbox. One approval publishes it where search and agents can find it.
- Today and the new-mission box offer "Start from a previous mission or result" and "Repeat this" as primary entries. Every result states what Brain reused.
- Reused items show provenance and freshness: last verified, used N times.
- Library becomes a first-class place merging documents, knowledge, Plays and tools, with these defaults on.
- A token and cost meter at run, task, mission and workspace level, with a mission token ceiling.
- Each task receives a bounded, recorded context pack built by the Governor, with deterministic compaction by reference, visible to the human.
- Default governed tools for knowledge, documents, web and supplied data, and a truthful tool registry.
- A repository context-budget script that reports and enforces what agent sessions load.

## User Stories

1. As a new user, I want Brain to suggest similar past missions before I describe my goal in full, so that I do not redo solved work.
   Amended (track P): there is no suggestion step. The plan drafts by itself as the page opens, handed the relevant past work: items sharing at least half of the goal's distinctive terms (and at least two), BM25-ranked, Plays excluded (they are templates, not past work), verified knowledge and outputs first, at most three. A calm collapsed line "Used from past work: N items (change)" shows them; unticking one makes "Redraft with my changes" appear. Mission titles lead with the picked Play or earlier mission, then the tidied sentence.
2. As a planner agent, I want relevant past plans, published knowledge and handoff facts with provenance in my context, so that I propose plans that have worked.
3. As an owner, I want "Start from a previous mission" on the main box, so that a new mission begins with the old brief, criteria and outputs as inputs.
4. As an owner, I want "Repeat this" beside it, so that recurring work is one click (with #56).
5. As an owner, I want every result to say what Brain reused, so that I can judge and correct it.
6. As an owner, I want each reused item to show when it was last verified and how many times it was used, so that I can tell stale from proven.
7. As an owner, I want to turn a finished verified mission into knowledge in one click, so that capitalization does not depend on my remembering.
8. As a reviewer, I want proposed knowledge to arrive as a readable card with sources, decisions, what failed and what it cost, so that I can approve in seconds.
9. As a reviewer, I want approving to publish it, so that search and agents can use it immediately.
10. As an owner of a one-person install, I want a defined rule for reviewing my own proposals, so that capitalization is not blocked by the two-person rule.
11. As an owner, I want a finished mission to propose a Play with its criteria, so that good plans become templates after human review.
12. As an owner, I want Library as a top-level place with documents, knowledge, Plays and tools, so that I find what Brain knows in one place.
13. As an owner, I want "Save as knowledge" on an output to make it searchable by agents, so that it is not a dead file.
14. As an agent, I want a governed `knowledge.search` tool, so that I can look things up within my scope.
15. As an agent, I want `documents.read`, bounded `web.fetch` and `csv.query` tools, so that ordinary research and data tasks work.
16. As an owner, I want the tool registry to show which agents may call a tool, call counts, last use and last failure, so that tools are discoverable and auditable.
17. As an administrator, I want honest registry data (activation time, trust, proof), so that I can trust the page.
18. As an administrator, I want to define what a zero per-attempt spend cap means, so that paid endpoints do not fail every run.
19. As an owner, I want tokens and dollars per run, task, mission and workspace, so that I see usage even when local models cost nothing.
20. As an owner, I want a mission token ceiling that pauses work like the dollar budget, so that local runs are bounded.
21. As an owner, I want estimated usage marked as estimated, so that I do not mistake it for settled.
22. As an owner, I want to open "Context this task received" and see sections, token sizes and truncations, so that I can debug a bad run.
23. As an owner, I want long handoffs compacted deterministically with a way to fetch the full text, so that context stays inside the budget without hidden loss.
24. As a developer on this repo, I want `pnpm` to report always-loaded and on-demand documentation tokens, so that I know what each agent session costs.
25. As a developer, I want thresholds enforced in the fast verification, so that docs do not silently bloat.
26. As an auditor, I want every reuse, publication and compaction recorded with actor and digests, so that I can trace what influenced a result.

## Implementation Decisions

- Reuse index: a Governor read over achieved missions, verified output versions, published knowledge, Plays and current handoff facts. Retrieval is SQLite full-text ranking (BM25) plus recency, deterministic, no model call. Each hit carries provenance (mission, verdict, evidence digest), last verified time and a use count. Use counts increment when an item is attached to a plan or session context, never on display.
- Reused items enter the planner and agents as claims-with-provenance context; they never count as evidence for a criterion (glossary: Evidence, Knowledge asset). Only items with a verified source qualify as knowledge; handoff notes stay claims and are not capitalized.
- Memory is one searchable surface: published knowledge assets, saved documents and published memory publications are indexed together with a source type; `sourceTypes` filters are honored. Local mode is labelled "Local store"; degraded is reserved for an unreachable configured remote.
- Capitalization output becomes readable: a deterministic template (goal, success criteria with check basis, accepted decisions, verified outputs, what the verdict rejected and why, tools used, cost and duration) carrying claim basis. No model summary, no member notes, messages or transcripts (GLOSSARY: Capitalization run). Provenance is the mission's evidence bundles.
- Review: one Library inbox lists proposed knowledge and proposed Plays; a non-blocking "result ready" style attention item announces them (depends on #52's glossary and ADR work). Approve = reviewed + published in one action by a principal other than the publisher; the single-owner rule is a decision ticket (options: second principal, owner self-review with step-up and a visible "self-reviewed" mark, or time-delayed re-confirmation) and may need an ADR before implementation.
- Suggest a Play: a draft release-defined Play document (plan version, team, criteria) goes into the existing draft flow for compile and activation; this assumes the gap analysis Q1 answer (release-defined) and must be confirmed.
- Context pack: for every session the Governor builds an ordered, budgeted pack: constraints and criteria, accepted decisions, dependency handoff facts, handoff notes, pinned inputs (by reference), reused knowledge, checkpoint. Each section has a token budget derived from a per-agent context budget; over-budget sections are compacted deterministically (facts and decisions first, prose truncated, large bodies replaced by a reference the agent can fetch through a read tool). The manifest (sections, estimated tokens, truncations, source digests) is stored as an immutable artifact referenced by the run. Token counts before a run are estimates and labelled so; actual usage comes from engine events.
- Usage ledger: one record per attempt (input, output, cached tokens, micro-USD, accounting, estimated) written at settlement and deduplicated by usage id; Governor reads total by attempt, task, mission and workspace. Mission budget gains an optional token ceiling enforced where admission enforces dollars. Cost caps beyond this belong to #55; #55 should read the ledger.
- Per-attempt spend: define `maxMicroUsd: 0` as one of {unbounded, local-only}; recommended: unbounded per attempt with the mission budget as the bound, and engines check only a positive cap.
- Default tools (all read-effect, governed, digest-pinned, shipped in the starter release and attached to the agents that need them): `knowledge.search`, `documents.read`, `web.fetch` (host allowlist from policy, size and time bounds), `csv.query` (read-only SQL over a supplied artifact). Document or deck generation is a needs-triage decision.
- Registry read reports release activation time and real proof; a read-side usage summary (agents allowed, calls, last call, last failure) comes from tool events.
- Repo context budget: a script with a checked-in budget file listing always-loaded sources (AGENTS.md and what it imports, instruction files in `opencode.json`, skill descriptions) separately from on-demand documents, with token estimates, per-group ceilings and a largest-files list; it runs in the fast verification.
- Breaking changes are allowed (AGENTS.md): no compatibility with the old raw-JSON asset shape.

## Testing Decisions

- Test external behaviour at the Governor command/query API with a real store and the browser suite; not component internals.
- Reuse: a mission is achieved, then a similar goal returns it ranked with provenance; use counts change only on attach; a revoked asset disappears; scope is rechecked.
- Capitalization: closing a mission produces a readable asset with provenance; approve by a different principal publishes and makes it searchable; self-publish is refused unless the decision ticket allows it; member notes never appear.
- Context: table-driven tests over section sizes and budgets assert deterministic compaction, reference round-trip and manifest digest; a run records its manifest.
- Usage: ledger totals equal summed engine events; duplicates of a usage id count once; the token ceiling pauses admission like the dollar budget.
- Tools: broker tests per tool (schema, scope recheck, size bounds, denied host); registry shows real activation time.
- Repo budget: script test over a fixture tree asserts report and non-zero exit above a ceiling.
- Prior art: `tests/integration/memory.test.ts`, `tests/integration/capitalization.test.ts`, `tests/integration/mission-admission.test.ts`, `tests/integration/claude-engine.test.ts`, browser suite.

## Out of Scope

- Model-written summaries as evidence; automatic prompt tuning; OpenTelemetry export.
- Remote TencentDB feature work beyond honest labelling.
- Source-watching connectors and domain Play content (gap analysis G1, G7).
- Dollar caps and estimates (#54, #55), the Quality page (#63).

## Addendum: hands-off capitalisation and starter Plays (track M, backlog 47-50)

- Write-ups add the worker's Result summary, a 2400-character deliverable excerpt, per-criterion worker evidence, assumptions and what was reused (`capabilities/writeup.ts`); empty sections are omitted. Not written up: titles starting `Sample goal`/`Test`/`Smoke`/`Demo`/`Dummy`/`Hello`, or under 200 characters of result. A newer write-up of the same goal supersedes the older (`superseded_by`).
- Auto-publish: `library_settings` (no row = on). A sweep after each capitalization pass publishes a waiting write-up as self-reviewed and automatic when nobody else could review it and it has no secret; `knowledge.approveVerified` approves all waiting ones; Withdraw is `memory.revoke`. Today shows "Brain learned N things this week".
- Starter Plays: six documents in `examples/v1/starter-release/config/plays/`; `plays.addStarter` merges missing ones into the active release, stages and activates it, skipping Plays whose agent is absent.

## Further Notes

- Small fix made with this spec: local memory search ranking (`memory.ts`, with a test).
- Vocabulary: use Play, knowledge asset, capitalization run, memory publication, mission brief. Avoid playbook, lessons learned, insight, unqualified memory, context dump.
- Screen overlap: tracks B (mission and Result pages, Outputs), C (Administration, Tools), E (polish) and #47, #49, #52, #54-#56, #61, #63; each ticket lists its own sequencing.
