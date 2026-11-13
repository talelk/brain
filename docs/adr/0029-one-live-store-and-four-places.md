# 29. One live store, four places, one vocabulary

Date: 2026-11-13
Status: Accepted (phase 2, "one simple surface")

Sixty-eight refresh timers let two parts of a page disagree (header "2 things need you" over ten results), seven sidebar places hid how work fits together, and screens worded one thing many ways.

**Decision.** The web keeps one live store (`apps/web/src/data/live.ts`). The Governor's execution stream says that something changed (`GET /v1/events?live=1&wake=1&after=head`, one small `changed` frame per batch); every mounted read re-loads together, coalesced, and the header carries the one Refresh and freshness label. No screen owns a timer; a guard test forbids `setInterval` and `refreshMs` outside the store. Three honest exceptions live inside the store: a 20 s safety re-read, a 10 s pulse while the stream is down, and a faster pulse a screen asks for while progress emits no events (a model download, a draft being written). Attention and missions are shared reads, so the bell, Today, Missions and Working now agree.

**Four places** (Today, Missions, Library, Administration), set in `ui-screen-contracts.json` (`area`). Live, Outputs and Schedules are views of missions, Logs and Runners sit under Administration. `/` opens Today, whose Working-now strip and decision cards say what runs and what needs a person; there is no landing rule.

**One vocabulary.** Screens speak of Mission, Plan, Task, Result and Check; run, session, attempt and release appear under Details. Words come from a message catalogue (`apps/web/src/i18n`: English, French, Arabic; Arabic is right to left through the document direction, never through bidi marks). Everything that needs a person is one decision card (what happened, why, the recommended action, the other options) with two verbs, Decide and Retry.

**Outputs.** The answer to the goal leads, then one result per task; attempt records fold under Attempts and never count as results. `artifacts.list` names the producing task, returns the true total and pages by cursor.

Rejected: a longer polling interval (the disagreement stays).
