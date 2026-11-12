# Review of Plan, Live and Outputs (2026-11-12)

Walked in Chrome on two instances: the live site (read-only, real data of workspace `sre-demos`) and a throwaway local copy with the seeded demo workspace (`operations`). Items marked *(seed)* come from the seeded data only and need confirming on real data. Nothing on the live instance was changed.

Not covered: creating a mission, confirming a plan, accepting a result and a run in progress end to end. Those would change the live data, and the local copy had no runner. Walk them on a local instance with enrolled runners next.

## Fix first (wrong or misleading)

1. **The reviewer's verdict names an internal id, not the criterion.** Banner on a failed result: "3 of 4 criteria met, not met: criteria-met". The report's own checklist says "1 of 3 met". Say which criterion failed, in its own words, and use one count.
2. **A parked task shows no reason and no history.** The panel says "Parked after 3 failed attempts" twice, and "Tasks for this item: No tasks started yet" while three runs failed. List the attempts with their time, outcome and the reviewer's reason, each linking to its run.
3. **"Final" on an output that failed its independent check.** The list badge should follow the verdict (Needs changes), not the file's lifecycle.
4. **Live suggests "Restart the task as a new dispatch" on a finished or failed session, calling it "interrupted".** That competes with the real fix (Decide / Run this task with) and is wrong for a reviewer failure.
5. **Outputs count looks capped at 100** (91 + 9 files = exactly 100 for one mission). Check the query limit and show the true number.
6. **Counts that disagree.** Missions header "2 things need you" vs 10 results below; Live *(seed)* "Working now (1)" vs 6 runs "Running"; Live "Live only (0)" next to 50 earlier sessions.
7. **Mission Outputs tab says "No results yet"** while the Missions page offers a ready result *(seed)*: check how outputs are linked to missions.

## Plan (mission page)

8. The same plan appears twice (the Plan card and Mission work) and progress and budget three times (header and Mission work). The header block fills the first screen on every tab, so the content starts below the fold.
9. "What this plan may take" says "unknown" three times when nothing is estimated. Hide it, or ask for estimates.
10. Three labels for one idea: Unblock, Decide, Retry. Use one.
11. Jargon: "Generate another strategy", "Plan version", "Stage 1 · no prerequisites".
12. "While you were away" repeats identical events (two "Plan proposal awaiting review", two "Plan version confirmed"). Group them with counts.
13. A blocked task is described ("Next: fix that, then press Unblock") but not linked.
14. The mission page says "2 tasks are running" while Live says it is waiting for a runner with 0 sessions *(seed)*.

## Missions list ("Needs you")

15. One problem appears twice: the mission "needs attention: all remaining work is parked" and the parked task. Show the mission once, with the task inside it.
16. Four "Result ready" rows for already finished missions sit among things that need a person. Keep finished results out of the queue, or in a separate "Results" section.
17. Usage shows two unlabeled lines (workspace total, outside missions). Label them.
18. The mission title is repeated as its own subtitle.
19. The parked reason reads "Step respond failed: the independent check did not pass (criteria-met)": internal step and check names.

## Live

20. With nothing running, it opens on an arbitrary old stopped session. Open on "Nothing is running" with the latest outcome and the next step.
21. 50 sessions have the same title; only "ran 3s" or "ran 1 min 37s" tells them apart. Show attempt number, time ago and outcome, and mark the author session versus the independent check.
22. Raw ids and event names in the inspector: `Run job-…`, `Work item work-…`, "attempt · progress", Engine "Not reported", Tokens "0 of 100,000" for a finished session.
23. The session of a task is called just "session" *(seed)*; use the task title. "This agent cannot be redirected while it works" is unexplained.
24. "View logs" twice; "Attach" and the "Live only" toggle are unclear. Check whether Stop asks for confirmation.

## Outputs

25. 24 of the first 25 files are technical run files; only one is a result. Default to results (one per task) and put run records behind "Technical files", outside the counts and the paging.
26. The "What Brain reused" block (three entries with Self-reviewed and Remove) sits above the actual results. Move it below or collapse it.
27. Files are named by internal ids on some outputs *(seed: `docver-…md`)*. Name every output after its task.
28. "Preview unavailable: artifact not found" and "History unavailable" *(seed)* are unfriendly; say what to do.
29. The result preview itself is good (summary first, Copy as Markdown, Download).

## Across the app

30. **A raw nginx "502 Bad Gateway" page appeared during the deploy.** Add a maintenance page that retries by itself, and have the app reconnect.
31. Logs: the stream badge stays on "Connecting"; "Session scope: Paste a session reference…" is awkward.

## Root cause behind the blocked SRE mission

Plan tasks default to the general task worker, which has no `host.exec`; the SRE recipe is marked `system`, so the planner never picks it. The mission's task therefore failed three times with an honest "I cannot reach container telemetry" report. Two product gaps made it impossible to fix from the UI: the "started work" guard counted parked tasks (now fixed), and no control changed a task's recipe (now added: Run this task with). Still open: pick a capable recipe automatically (see the capability-gap row in the backlog).


# Second pass on the live instance (read-only)

Today, Logs, Library, Schedules, Approvals, Runners, Health, Releases, Quality, Workspaces, Integrations, a result page and the real mission's Live tab, on the live `sre-demos` workspace.

## Fix first

32. **A reload, bookmark or new tab on `/settings`, `/runners`, `/approvals` or `/administration/*` silently switches to the first workspace ("My workspace").** The `sre-demos` approvals and the attention badges disappear, and "Today" then opens the other workspace. `?w=` is ignored on `/quality`. Clicking through inside the app keeps the workspace. Remember the last workspace per browser and honor `?w=`.
33. **The Workspaces card says `sre-demos` has "No approval or blocked-run exceptions", "Waiting on someone: 0" and Healthy**, while a task is parked and the mission "needs attention". Count parked and stopped work.
34. **Logs says "A tool made a change." (4 times) for a read-only SRE run.** Alarming and wrong for read tools; say "A tool ran (read-only)".
35. **"See result" opens the Library Review inbox, scrolled into a long list of "Replaced" write-ups**, not the result. Open the result, or focus the write-up.
36. **Today offers Retry inline for a parked task whose cause is a missing tool.** Retry reruns the same recipe and fails three more times. Offer "Run with another recipe" beside it, with the reason in plain words.

## Enhancements

37. Instance-wide pages (Quality, Setup, Releases, Health, Workspaces) show a workspace switcher that does nothing for them. Health, labelled "Whole instance", lists one workspace's recent activity.
38. Health checks only three services. Add the launcher (host commands) and the model endpoint. "Everything is working" is shown while work is parked.
39. Logs: "Records 10 · head 56269" next to a chart of 200 records; the stream badge stays on "Connecting"; raw agent text is dumped into a log row and cut mid-sentence.
40. Today: "Install Brain on your phone" shows on desktop. "Latest missions" repeats the title as the subtitle for some missions and prints the full intent paragraph for others.
41. Releases: raw digests in the text ("Activated from sha256:…", "Built from 8c1c…"); 12 releases pile up (every deploy and staging adds one); every option in the dropdown reads "8 workflows · 7 agents".
42. Schedules is empty although a weekly health mission exists: offer to schedule it.
43. On the real mission's Live tab the side panel says "Verdict: rejected", yet the main call to action still suggests restarting the task.
