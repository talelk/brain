# Backlog (ranked; update status, do not delete)

| # | Item | Track | Status (2026-11-11) |
|---|------|-------|---------------------|
| 1 | General-purpose research/write workflow + evaluator, readable deliverable; planner stops creating clarify-with-human tasks | A | built: `general-task` workflow + `task-validator`, planner no longer makes clarify tasks; needs release restage + activation on live |
| 2 | Outputs: one result per task up front; Logs readable default | B | not started |
| 3 | Administration screens audit + fixes | C | first pass done 2026-11-11 (`022b2c0`); follow-ups rows 8-12 |
| 4 | Competitive/spec research -> `docs/research/` and ranked product gaps | D | done 2026-11-11 (`b350f76`); caveat: Codex page 403, gap 6 'no email/Slack' from limited grep |
| 5 | Plain-language failure reasons for failed runs/tasks | B/C | not started |

## Added 2026-11-11 (user: "also implement all research outputs & beautify & polish ui more")
| # | Item | Track | Status |
|---|------|-------|--------|
| 6 | Implement every gap in `docs/research/best-product-gap-2026-11.md` (track D output), ranked, as spec -> tickets -> implement-spec | F | waits for D |
| 7 | Visual polish pass across all screens: spacing, type scale, empty states, motion, dark mode, mobile; one design language | E | waits for B and C (they edit the same files) |

## Research gap mapping (2026-11-11, from `b350f76`)
Gaps 1 (general workflow) and 2 (planner stalls) -> track A. Gap 3 (one Result per task, plain logs/failures) -> track B. Gaps 4-12 (first-run box + inline setup fixes + sample goal; trust/'how was this checked' + needs-me queue/notifications; cost estimates; scheduling; mobile Today; live steer; quality dashboard) -> track F (spec + tickets, then implement after B/C land).

## Track F published (2026-11-11, `talelk/brain@fb51b05`)
Spec `docs/specs/hands-off-product-shell.md` = issue #46; 18 sub-issues #47-#64, native blocked-by edges. Order: #47 Today landing box, #48 inline setup fixes, #51 needs-you queue, #49 trust line, #52 result-ready item, #53 notifications (verify 'no email/Slack' claim first), #54 cost/time estimates, #55 actual cost + spend cap, #56 repeat-this schedules, #57 occurrence diff, #58 phone Today, #59 install badge, #61 live doing-now line, #62 pause/steer/stop, #63 quality page, #50 challenge result, #60 share link, #64 feed re-opens into evals.
Sequencing: after B -> #49 #50 #54 #55 #56 #57 #60 #61; after C -> #48 #53 #56; after E (polish) -> #51 #58 #61; #47/#51 overlap B; no screen conflicts: #52 #63 #64.

## Added 2026-11-11 (user: "look also for existing research & add them as default features, check also tools & memory & capitalization & fix them enhance them add also token budget meter of the repo & how to manage context")
Track H (spec + tickets): existing-research-to-defaults, tools audit, memory audit, knowledge capitalization loop, token/cost budget meter (run/task/mission/workspace), agent context management, and a repo-side token budget meter for the agent workflow. Ambiguity noted: "of the repo" read both as product meter and as a developer meter for AGENTS.md/skills/docs size; track H covers both.

## Track C follow-ups (2026-11-11, from report on `022b2c0`)
| # | Item | Track | Status |
|---|------|-------|--------|
| 8 | Setup heading mismatch ("Models & Providers" under "Workspace setup"); Runners and Integrations empty states untouched; Security/Authentication only light changes | C2 | open |
| 9 | Access page: person's name missing on rows (not investigated) | C2 | open |
| 10 | Click through Releases with an existing release, the invite flow and failure states in a browser (only the operational spec covered them) | C2 | open |
| 11 | Pending invitations depend on the outbox and nothing tells the admin to share the link | C2 | open |
| 12 | Run the other viewports (390-dark etc.) and the dark/RTL projects for the admin specs; regenerate baselines intentionally | C2 | open |

## Track A follow-ups and user addenda (2026-11-11)
| # | Item | Track | Status |
|---|------|-------|--------|
| 13 | Stage + activate the new release (general-task, task-worker, task-validator, task.validate, plan-guide change) on the live server; confirm `general-task` in catalog; restart runners; validate with a plain-words mission in Chrome. Steps in track A report (see `docs/howto/compile-activate-release.md`); first find how the live release was built (starter vs `releases/cv-insights`) | chief | open, needs deploy password |
| 14 | Outputs "Result" preview is raw JSON with escaped Markdown; render the deliverable as Markdown (track B row 2) | B | open |
| 15 | Evaluator is deterministic (proves criteria answered, not correct); measure real-model quality; consider a model-judged independent check | A2 | open |
| 16 | Downstream tasks only see upstream handoff summaries, not the full deliverable; provide selective full-deliverable context within a budget (ties to track H context management) | A2/H | open |
| 17 | User addendum 2026-11-11: reuse and capitalisation must be first-class (search-before-plan, one-click play/knowledge from verified work, 'Start from previous', provenance/freshness, 'what Brain reused' on every result) | H | sent to track H |

## Track G published (2026-11-11, reuse, memory, tools, tokens, context)
Spec `docs/specs/reuse-memory-tools-and-context.md` = issue #65; sub-issues #66-#85, native blocked-by edges. Owner direction: reuse and capitalization are first-class. Order: #66 reuse index, #67 readable knowledge assets, #68 planner receives reuse, #69 start-from-previous and Repeat entries on the Today box (blocked by #47), #70 'what Brain reused' line, #71 Library review inbox, #72 single-owner review decision, #73 Library navigation (needs-triage), #74 suggest a Play (needs-triage), then search, usage ledger, meter, token ceiling, spend-cap decision, context pack, compaction, knowledge.search tool, default tools, registry, repo context budget script.
Small fix made: local memory search ranks by matched terms then recency (`memory.ts`).
Not fixed on purpose: `maxMicroUsd: 0` fails paid-endpoint runs (decision ticket).
