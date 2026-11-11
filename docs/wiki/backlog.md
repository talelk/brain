# Backlog (ranked; update status, do not delete)

| # | Item | Track | Status (2026-11-11) |
|---|------|-------|---------------------|
| 1 | General-purpose research/write workflow + evaluator, readable deliverable; planner stops creating clarify-with-human tasks | A | built: `general-task` workflow + `task-validator`, planner no longer makes clarify tasks; needs release restage + activation on live |
| 2 | Outputs: one result per task up front; Logs readable default | B | shipped `f470178`, deployed live 2026-11-11 ~00:40; browser check in progress |
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
| 13 (DONE 2026-11-11: staged and activated release `sha256:c6b977ed54bc58e0ded9e9e27d2937fd762e9a3bda767130ccad4fef7883f93e` via CLI inside container `brain-governor-1`, sign-in with `Origin: https://brain.mykeyrus.tn`, runners restarted) Stage + activate the new release (general-task, task-worker, task-validator, task.validate, plan-guide change) on the live server; confirm `general-task` in catalog; restart runners; validate with a plain-words mission in Chrome. Steps in track A report (see `docs/howto/compile-activate-release.md`); first find how the live release was built (starter vs `releases/cv-insights`) | chief | open, needs deploy password |
| 14 | Outputs "Result" preview is raw JSON with escaped Markdown; render the deliverable as Markdown (track B row 2) | B | open |
| 15 | Evaluator is deterministic (proves criteria answered, not correct); measure real-model quality; consider a model-judged independent check | A2 | partly done 2026-11-11: `node scripts/qualification/task-quality.mjs --runs N [--judge]` measures a real model (validator pass rate, empty/unparsed answers, judge agreement); a model-judged check inside the workflow is still open |
| 16 | Downstream tasks only see upstream handoff summaries, not the full deliverable; provide selective full-deliverable context within a budget (ties to track H context management) | A2/H | done 2026-11-11 for the work chain: dependents get quoted, size-bounded excerpts of upstream deliverables (12000 chars shared, cut at a paragraph); wider context management stays with track H |
| 17 | User addendum 2026-11-11: reuse and capitalisation must be first-class (search-before-plan, one-click play/knowledge from verified work, 'Start from previous', provenance/freshness, 'what Brain reused' on every result) | H | sent to track H |

## Track G published (2026-11-11, reuse, memory, tools, tokens, context)
Spec `docs/specs/reuse-memory-tools-and-context.md` = issue #65; sub-issues #66-#85, native blocked-by edges. Owner direction: reuse and capitalization are first-class. Order: #66 reuse index, #67 readable knowledge assets, #68 planner receives reuse, #69 start-from-previous and Repeat entries on the Today box (blocked by #47), #70 'what Brain reused' line, #71 Library review inbox, #72 single-owner review decision, #73 Library navigation (needs-triage), #74 suggest a Play (needs-triage), then search, usage ledger, meter, token ceiling, spend-cap decision, context pack, compaction, knowledge.search tool, default tools, registry, repo context budget script.
Small fix made: local memory search ranks by matched terms then recency (`memory.ts`).
Not fixed on purpose: `maxMicroUsd: 0` fails paid-endpoint runs (decision ticket).

## Live state and wave 2 (2026-11-11 ~01:00)
- Live runs `main` at `ee0638e`+ and release `sha256:c6b977ed…` (general-task). Browser check: planner no longer creates clarify tasks; task 1 and 2 of a plain-words mission finished by themselves; task 3 (review, general-task) parked after 3 failed attempts, overlapping a deploy restart -> track A2 diagnosing (rows 15-16 included).
- Track G done (`961a6f9`, `ab7e263`, ADR 0005): result-ready attention item + Quality page (#52, #63). Track H done: spec #65 + issues #66-#85 (`c0c257f`). Track C2 (admin follow-ups) still running.
- Wave 2 started: A2 (live failure + evaluator robustness), I1 (#47 Today), I2 (#76-#79, #54, #55 usage/cost), I3 (#66-#75 reuse/capitalisation), I4 (#80-#85 context/tools/repo budget). UI polish E and #48/#49/#51/#53/#56-#62 wait for these to land.
- Environment fixes: eslint ignores `.claude/worktrees/**` (`ee0638e`) so verify:fast works with parallel worktrees; credentials stored in `~/.config/brain-dev/credentials.env` (never copy values).
- Known flaky under load: `tests/integration/storage.test.ts` LRU and `first-launch.test.ts` time out when run in parallel with other suites; pass alone.

## Live browser findings after deploy of `f470178` (2026-11-11 ~01:25)
| # | Item | Track | Status |
|---|------|-------|--------|
| 18 | Logs Readable shows raw streamed fragments ("The agent said: ution:** Day 2 ... \n\n") and repeats generic lines ("A tool made a change", "Brain reported progress"): aggregate token chunks into one message per turn, collapse repeated generic lines, name the task on every line | L (logs readability) | open |
| 19 | Mission page Outputs tab says "No outputs yet / Named outputs" while tasks produced Result cards; workspace Outputs preview shows raw JSON with escaped Markdown; trust line is jargon ("No evidence bundle pins this digest") | I6 | in progress |
| 20 | New-mission dialog still defaults to "Start from a play" tab although plain-words is the common path (I1 / #47 removes the toggle) | I1 | in progress |
| 21 | Review task (general-task, real model) produced a good review but stayed Unverified and parked after 3 attempts, overlapping a deploy restart | A2 | in progress |
Confirmed good live: planner no longer creates clarify tasks; plan drafts by itself and opens on Plan; tasks 1-2 finished by themselves ~20s after confirm; Outputs leads with one Result per task with technical files collapsed; mission page slimmer (Live/Plan/Outputs + More views); "Result ready" items appear in Missions and the bell; Administration in sidebar.

## Track I2 (usage and cost), 2026-11-11
- #76 usage ledger, #77 meter at run/task/mission/workspace, #78 token ceiling, #54 plan estimates, #55 result cost and workspace spend cap, #79 zero cap rule (ADR 0006): built; see ADR 0007. Open: interactive (non-mission) runs are not in the ledger totals or the cap; Live console per-session token readout not added.
## Track I1 (2026-11-11): Today landing and reuse entries (#47, #69 partial)
Built: `/w/:id/today` (first nav entry, landing target), one "What do you want done?" box shared with the New mission dialog (no mode toggle; plays, "Start from a previous mission" and "Repeat this" are chips), Governor default budget (`DEFAULT_MISSION_BUDGET`: $5, 3 members, no wall limit), landing rule (Today unless work is active and the queue is empty). Seams for later tracks: `apps/web/src/ui/start/reuse.ts` (`ReuseSource` -> #66 index; `repeatHref` -> #56 picker). Not done: pinning the old verified outputs as typed inputs (needs the planner to read the source mission, #68); the brief only names the source mission.
