# Backlog (ranked; update status, do not delete)

| # | Item | Track | Status (2026-11-11) |
|---|------|-------|---------------------|
| 1 | General-purpose research/write workflow + evaluator, readable deliverable; planner stops creating clarify-with-human tasks | A | not started |
| 2 | Outputs: one result per task up front; Logs readable default | B | not started |
| 3 | Administration screens audit + fixes | C | not started |
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
