# Best-product gaps for a hands-off "describe the goal, get verified results" Brain

Date: 2026-11-11. Repo state: `main` at `70b9256`. Track D of the owner backlog (`docs/wiki/backlog.md` item 4).
Reads: `docs/wiki/*`, `docs/functional-spec.md`, `GLOSSARY.md`, ADR-0001..0004, `docs/research/agentic-os-gap-analysis.md` (not repeated: its G1-G7 are domain/pack gaps; this file is about the core experience).

Limits of this research. Sources were fetched via search snippets and a few page fetches on 2026-11-11. OpenAI's Codex page returned HTTP 403, so Codex claims rest on search summaries of the launch post and system card. Cursor, Claude Code, Manus, Temporal and OpenTelemetry claims come from search summaries of vendor docs. Nothing here quotes more than a few words. Brain-side citations were read in the repo. Code behaviour not listed was not verified.

## 1. What leading products converge on (evidence)

| Pattern | Evidence (primary source) |
|---|---|
| Plan is shown and editable before autonomous work starts | Cognition, "Devin 2.0", 2025-04-03: Devin researches the codebase and drafts a plan the user can modify (https://cognition.ai/blog/devin-2). Claude Code plan mode: research and propose without editing; approving a plan switches mode (https://code.claude.com/docs/en/permission-modes). |
| Result comes with checkable evidence, and the agent says when it is unsure | OpenAI Codex launch (2025-05) describes citations to terminal logs and test outputs, and explicit statements of uncertainty or test failure (https://openai.com/index/introducing-codex/, summarised via search; page itself returned 403). Its system card reportedly notes false success claims on impossible tasks, which supports Brain's "no self-reported success" rule. |
| Ground truth from the environment beats model judgement; use evaluator loops only with clear criteria | Anthropic, "Building effective agents", 2024-12-19 (https://www.anthropic.com/engineering/building-effective-agents). |
| Work leaves the laptop: web/mobile (PWA) launch, Slack in and out, completion ping with a link to the result | Cursor Web & Mobile docs and Slack docs (https://docs.cursor.com/background-agent/web-and-mobile, https://docs.cursor.com/en/slack); TechCrunch reported launch 2025-06-30. |
| Delegation keeps a human accountable; triage rules route work to agents; insights per agent | Linear docs, "Assign and delegate issues" and agent guidelines SDK (https://linear.app/docs/assigning-issues, https://linear.app/changelog/2025-07-30-agent-interaction-guidelines-and-sdk). |
| Durable pause-for-human as a first-class primitive | LangGraph `interrupt()` + checkpointer, resume with same thread (https://docs.langchain.com/oss/python/langgraph/interrupts). Temporal Signals for approval, waiting costs no compute (https://docs.temporal.io/ai-cookbook/human-in-the-loop-python.md). Brain already has this (ADR-0004, approvals). Not a gap. |
| Recurring tasks with run history and pause/edit; failed jobs retried | Manus scheduled tasks docs (https://manus.im/docs/features/scheduled-tasks). |
| Context engineering: filesystem as memory, keep errors in context, reversible compression | Manus, "Context Engineering for AI Agents", 2025-07-18 (https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus). |
| Standard trace vocabulary for agent runs (invoke_agent, plan, execute_tool spans) | OpenTelemetry GenAI conventions; still "Development" status as of Aug 2026 per secondary sources, moved to a dedicated repo mid-2026. Treat as optional export, not a dependency. |

Reading across these: the best products win on (a) not making the user answer questions before work starts, (b) one clear deliverable with evidence attached, (c) reaching the user where they are, (d) legible cost and confidence. Brain's governance core (independent verdicts, exact-digest approvals, immutable evidence) is already ahead of all of them; its gaps are in the product shell around that core, which the 2026-11-11 dogfood confirms.

## 2. Brain today (short)

Strong: persistent missions, plan proposals with human confirm (`docs/functional-spec.md` UF-11), independent evaluator, scheduler with misfire/overlap (UF-12), attention items with in-app inbox plus web push, rate-limited to one per mission per 15 min (`apps/governor/src/modules/operations/attention-notify.ts`), since-last-visit summary (`apps/web/src/routes/pages/MissionPage.tsx` line ~241), budget meter (same file line ~102), PWA assets (`apps/web/public/manifest.webmanifest`, `sw.js`), TV boards.

Weak, from `docs/wiki/archive/dogfood-2026-11-11.md`: only two workflows, so unrelated tasks were marked Done with nonsense (item 1); 6-12 machine files per task and raw JSON logs (item 2); planner produces human "requester" tasks that stall hands-off missions (item 3, `examples/v1/starter-release/agents/plan-guide.md` line "Identify human decisions as tasks when requirements are ambiguous"); failed runs unexplained (item 4); new-mission dialog mode flips (item 6).

## 3. Ranked gaps (12)

Ranking = leverage on "describe goal, get verified result, touch nothing else". Effort S (days), M (1-2 weeks), L (more). Risk is risk of the change itself.

### 1. A general research/write workflow with a real deliverable and a criteria-checking evaluator
- Why: the single worst dogfood failure. A task outside the two shipped workflows ran as incident triage and was marked Done. Codex and Devin earn trust by returning the thing asked for, with evidence (Codex post above). Anthropic: evaluator loops work "when we have clear evaluation criteria", which Brain's plan tasks already carry.
- Today: workflows only in `examples/v1/starter-release/config/` (operations-*, support-draft, plan-guide, task-guide, agent-smoke). Backlog #1 not started. Glossary rule: an LLM judge cannot establish success (see gap analysis C1).
- Change: add `general-task` workflow (agent writes `result.md` plus a short `sources.json`); evaluator is deterministic where possible (file exists, non-empty, required sections from criteria, every cited URL/path resolves, no placeholder text) and records per-criterion pass/fail with the LLM reviewer only as a supplemental signal; a task is Done only when each criterion has a verdict or an explicit human sign-off. Also make "no workflow fits" a visible Needs-you state, never a silent fallback to a wrong workflow.
- Effort L. Risk: medium; deterministic checks will under-cover prose quality, so the human-sign-off path must be one click.

### 2. First-run: from empty install to first verified result in under five minutes without choosing anything
- Why: the owner's brief is "i dont want to do anything manual". Manus/Cursor onboarding is a single prompt box. Cursor web starts agents from one input on any device (docs above).
- Today: UF-01 signs in with a default admin; UF-02/UF-11 need catalog, plays or a mission dialog whose default mode flips (dogfood #6); Setup follows readiness checks (`e4017e5`).
- Change: after sign-in, land on one big "What do you want done?" box; if model/runner not ready, Setup appears inline as a checklist with one fix button per item; ship one sample goal chip that runs end-to-end and produces a deliverable (proves the install). Remove the mode toggle from the new-mission dialog (always Describe; plays offered as chips). Add a fresh-install smoke test in the browser suite (AF-12 verify) asserting a sample mission reaches a verified result.
- Effort M. Risk: low.

### 3. Planner that never stalls on questions: assume, state, proceed
- Why: Devin's interactive plan is editable, not a questionnaire; Claude Code plan mode researches first and proposes. A hands-off product must resolve ambiguity by recorded assumptions, escalating only blocking or risky items.
- Today: `plan-guide.md` tells the agent to turn ambiguity into human tasks; confirmation is human-only (UF-11), and the owner reports stalls (dogfood #3).
- Change: change the plan-guide output schema (`schemas/plan-guide-output.json`) to carry `assumptions[]` (text, why safe, how to reverse) and `blockingQuestions[]` (max 2, only if no safe default). Human "requester" tasks are disallowed except for approvals or credentials. UI shows assumptions beside the plan with one-click "change this". Add an eval over a fixed set of vague goals measuring stall rate and criteria checkability (every criterion must map to a check or to human sign-off).
- Effort M. Risk: medium (bad assumptions); mitigated by assumptions being visible, reversible and recorded in the mission brief.

### 4. One result per task, up front; evidence one click below
- Why: Codex leads with the change and cites logs underneath (launch post). Brain leads with 6-12 JSON files.
- Today: Outputs list and raw JSON log lines (dogfood #2, backlog #2); output pages exist (`apps/web/src/routes/pages/OutputsPage.tsx`, `NamedOutputPage.tsx`).
- Change: task page shows exactly one Result card (rendered Markdown/table/diff, verdict badge, per-criterion checklist with evidence links). Everything else collapses under "How this was checked". Logs default to a plain-words timeline (what the agent did, tools used), raw JSON behind a toggle. Mission page gets a single "Deliverables" strip aggregating task results.
- Effort M. Risk: low.

### 5. Plain-words failure and "why not done" explanations with a next action
- Why: Codex surfaces uncertainty and failed tests explicitly; Manus keeps errors visible in context. A silent failure destroys hands-off trust.
- Today: failed runs say nothing readable (dogfood #4, backlog #5).
- Change: map the existing failure taxonomy (error codes, verdict reasons, budget stops, approval denials) to one sentence + one action button (Retry, Replan, Raise budget, Sign off manually). Deterministic template, no LLM summary (glossary: no AI summary for since-last-visit; keep that line). Show on task, mission and inbox.
- Effort S-M. Risk: low.

### 6. "What needs me" as one decision queue, delivered where I am
- Why: Cursor completion pings arrive in Slack with a link to the result; Linear keeps the human accountable via delegation. Brain's rule that only attention items notify is right and distinctive.
- Today: attention items, in-app inbox, web push to subscribed browsers, 15-minute per-mission throttle, approvals bypass throttle (`attention-notify.ts`); no email/Slack/Teams delivery found in `apps/governor/src/modules/operations/` (not exhaustively searched). Web push on iOS requires an installed PWA.
- Change: (a) a Needs-you page that is the default landing when non-empty, each row answerable inline (approve/reject with exact diff, pick option, sign off) without opening the mission; (b) add email (and optionally Slack/Teams webhook) channels with a per-user preference and a daily digest of non-urgent items; (c) notify on mission completion with the verdict summary, since "done" is the event owners most want; today completion is not an attention item by the glossary definition, so this needs an explicit glossary decision (a "result ready" item that is non-blocking).
- Effort M. Risk: medium (notification fatigue; keep throttle, make channels opt-in; step-up rules for approvals from email must still require sign-in per UF-10).

### 7. Trust UX: show confidence and independence, not just a green tick
- Why: Cognition added confidence ratings in Linear/Jira integrations (reported by third parties for Devin 2.1, 2025-05; not confirmed on a Cognition page). Codex system card reports false success under impossible tasks. Users need to see what kind of check passed.
- Today: verdicts and independence levels L1-L3 exist in the domain; the UI shows a verdict but the dogfood run showed "Done" with nonsense because the check was irrelevant.
- Change: every Done carries a trust line: "3 of 4 criteria checked by tests/files/hashes; 1 by human sign-off; 0 by model opinion". Criteria with only model-judged support show as "Unverified" and keep the task in Verifying. Add a "challenge this result" button that spawns a reviewer pass (the Skeptic role from the earlier gap analysis, G6) producing findings as claims, never verdicts.
- Effort M. Risk: low-medium (strictness can make everything "unverified"; tune with gap 1's deterministic checks).

### 8. Cost visibility before and after: estimate at plan time, live spend, per-result cost, hard stop
- Why: Cursor/Devin/Manus bill by usage and users fear runaway cost; the planner schema already allows per-task `maxMicroUsd`.
- Today: mission budget meter and spend hint on the mission cockpit (`MissionPage.tsx` lines ~102, ~185); task cost and plan-time estimate not seen in the dogfood notes. Not verified whether settled spend per task is shown.
- Change: plan screen shows estimated cost and time range per task and total, with "this plan will not exceed $X"; each Result card shows actual cost; a daily/weekly workspace cap with a clear "paused: budget" attention item and a one-click raise. Default per-mission budget set at first run so the user never has to configure one.
- Effort M. Risk: low. Estimates are model guesses; label them as such and show actuals prominently.

### 9. Scheduling in plain words, with "what did it do last time" in the results
- Why: Manus scheduled tasks suit recurring research, reports and monitoring, with pause/edit/history. Recurring "briefs" are the hands-off use case that compounds.
- Today: robust scheduler (UF-12: cron + IANA timezone, overlap, misfire, server-side preview) and `SchedulesPage.tsx`; targets are workflow ids or work items, which a non-technical user cannot choose.
- Change: "Repeat this" button on any finished mission/task: "every weekday 08:00, Europe/Paris" via a small preset picker with the server-computed next-5 preview; each occurrence creates a mission-linked run whose Result card diffs against the previous occurrence (what changed). Pause/skip failures with plain reasons (gap 5).
- Effort M. Risk: low-medium (depends on gap 1 so scheduled runs produce readable output).

### 10. Mobile and at-a-glance: a phone-first Today card and lock-screen-sized status
- Why: Cursor Web/PWA lets users start and monitor from a phone; the owner works across devices.
- Today: PWA manifest + service worker present; 390px screenshots are part of the UI revamp artifacts (`artifacts/ui-revamp/screenshots/390-dark`); TV boards for walls; Today route exists (`apps/web/src/routes/today.tsx`).
- Change: make Today the phone landing: top line "2 need you, 1 running, 3 done since yesterday", then the decision queue (gap 6), then results strip. Approve/reject must be thumb-sized and show the exact digest. Add a home-screen install prompt after first completed mission, a single-number app badge, and a share-link to a read-only Result for stakeholders (read-only, expiring, no workspace access).
- Effort M. Risk: low; share links need an explicit authorization decision (nothing in the spec grants read-only external viewers today; not verified).

### 11. Progress you can read while it runs: a one-line "doing now" and a take-over affordance
- Why: Cursor lets users watch and take control of a running agent; Claude Code surfaces tool activity and lets the user interrupt. Silent minutes feel broken.
- Today: Live and Logs pages exist (`LivePage.tsx`, `LogsPage.tsx`), console feed components; log default is raw JSON (dogfood #2).
- Change: one sentence per active task derived from structured events ("reading 4 sources", "waiting for evaluator"), an ETA band from estimatedMinutes versus elapsed, and three buttons: Pause, Steer (add an instruction that becomes a recorded mission-brief constraint, never a hidden prompt edit), Stop. Steering must go through the existing command funnel and audit.
- Effort M. Risk: medium (steering interacts with plan versions and the independence of the evaluator; steering text is untrusted data like any input).

### 12. Self-improvement loop: learn from sign-offs and re-opens, and expose a quality dashboard to the owner
- Why: Manus keeps failures in context and rebuilt its framework repeatedly; Linear Insights segment by delegate. The owner wants "best product" and needs to see whether it is getting better.
- Today: knowledge assets and capability candidates exist (glossary; gap analysis C4 limits capitalization to verified history). No product-level metrics view found; backlog tracks work by hand.
- Change: a small owner-only "Quality" page computed deterministically from existing records: % tasks verified without human help, stall rate, re-open rate after Done, cost per verified task, median time to first result, top failure reasons. Feed re-opens and manual sign-off rejections into the eval set used by gap 3 (regression suite of real goals). Keep it analytics, not automatic prompt rewriting.
- Effort M. Risk: low. Prompt auto-tuning is explicitly out of scope; the loop closes through the release process.

## 4. Suggested order

1 (deliverable + evaluator), 4 (one result up front), 5 (failure reasons), 3 (planner assumptions), 2 (first run), 7 (trust line), 6 (needs-you queue + channels), 8 (cost), 9 (repeat), 10 (mobile), 11 (live steer), 12 (quality). Gaps 1, 4, 5 are already the owner's backlog items 1, 2, 5; this ranking says do them first, and that gap 3 and 2 are what turn "works" into "hands-off".

## 5. Sources consulted (accessed 2026-11-11)

- Cognition, Devin 2.0 (2025-04-03): https://cognition.ai/blog/devin-2
- Anthropic, Building effective agents (2024-12-19): https://www.anthropic.com/engineering/building-effective-agents
- OpenAI, Introducing Codex (2025-05; fetch blocked, via search summary): https://openai.com/index/introducing-codex/
- Cursor, Web & Mobile and Slack docs: https://docs.cursor.com/background-agent/web-and-mobile , https://docs.cursor.com/en/slack
- Claude Code permission modes and hooks: https://code.claude.com/docs/en/permission-modes , https://code.claude.com/docs/en/hooks-guide
- LangGraph interrupts: https://docs.langchain.com/oss/python/langgraph/interrupts
- Temporal human-in-the-loop cookbook: https://docs.temporal.io/ai-cookbook/human-in-the-loop-python.md
- Manus scheduled tasks and context engineering (2025-07-18): https://manus.im/docs/features/scheduled-tasks , https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Linear assigning/delegating and agent SDK (2025-07-30): https://linear.app/docs/assigning-issues , https://linear.app/changelog/2025-07-30-agent-interaction-guidelines-and-sdk
- OpenTelemetry GenAI conventions (status disputed across secondary sources; treat as Development).
