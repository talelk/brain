# Spec: the hands-off product shell (track F)

Source: `docs/research/best-product-gap-2026-11.md` sections 3.2 and 3.6-3.12 (gap numbers are that file's). Its gaps 3.1 and 3.3 belong to track A, 3.4 and 3.5 to track B. Track C (Administration) and track E (visual polish) edit the same screens; sequencing notes are in each ticket.

## Problem Statement

A person who installs Brain wants to type what they want done and get a verified result without learning the product. Today they sign in to Missions or Live, face a new-mission dialog that flips between "play" and "describe", fix setup in a separate Administration area, and then see only a verdict badge. They cannot tell what kind of check passed, what a plan will cost before it runs, which notification is the one that blocks work, how to make a good result repeat, or how to steer or pause work that is running. On a phone the same questions are harder. The owner cannot see whether Brain is getting better.

## Solution

Add the product shell around the existing governance core, using existing records wherever possible and adding no AI summaries:

- A Today screen as the landing page: one "What do you want done?" box, inline setup fixes when the install is not ready, one sample goal that proves the install, then the decision queue and a results strip.
- A trust line on every Done result stating how each criterion was checked, with model-only support shown as Unverified.
- One "Needs you" decision queue answerable inline, a non-blocking "result ready" item, and opt-in delivery channels with a daily digest.
- Plan-time cost and time estimates, actual cost on results, and a workspace spend cap.
- "Repeat this" on a finished mission, with a diff against the previous occurrence.
- A phone-first Today and an install prompt.
- A "doing now" line, ETA band and Pause / Steer / Stop on running work, where steering is recorded.
- An owner-only Quality page computed from existing records.

## User Stories

1. As a new user, I want the first screen after sign-in to be one box asking what I want done, so that I do not choose between catalogs, plays and modes.
2. As a new user, I want my sentence to become a mission with a derived title and a default budget, so that I do not configure anything first.
3. As a new user, I want plays offered as chips under the box, so that I can still start from a ready-made team.
4. As a new user, I want the new-mission dialog to stop flipping between modes, so that it behaves the same every time.
5. As a new user on a fresh install, I want a "Try a sample goal" chip that runs end to end, so that I know my install works.
6. As a new user whose model is not connected, I want the box to show a checklist with one fix button per missing item, so that I fix setup without leaving the page.
7. As a new user, I want the box to be visibly blocked until setup passes, so that I never submit work that cannot run.
8. As an administrator, I want a fresh-install browser test to prove a sample mission reaches a verified result, so that a broken install is caught before users see it.
9. As an owner, I want Done results to say "3 of 4 criteria checked by tests, files or hashes; 1 by human sign-off; 0 by model opinion", so that I know how much to trust them.
10. As an owner, I want a criterion supported only by model judgement to show as Unverified and keep the task in Verifying, so that a model opinion never reads as success.
11. As an owner, I want each criterion's check, independence level and evidence link under "How this was checked", so that I can inspect any claim.
12. As an owner, I want a "Challenge this result" button that spawns a reviewer pass whose findings are claims, not verdicts, so that I can doubt a result cheaply.
13. As a person responsible for missions, I want one "Needs you" queue of everything that blocks work, so that I do not hunt through screens.
14. As that person, I want to approve or reject an approval inline with its exact digest, so that I do not open the mission first.
15. As that person, I want to confirm a plan proposal, pick an option, or sign off a criterion inline, so that decisions take one step.
16. As that person, I want Today to lead with the queue when it is non-empty, so that the most important thing is first.
17. As that person, I want a non-blocking "result ready" item when a mission finishes, so that I hear about the event I care about most.
18. As that person, I want progress never to notify, so that notifications keep meaning "needs you".
19. As that person, I want to choose per channel (in-app, web push, email, webhook) what reaches me, so that I control interruption.
20. As that person, I want a daily digest of non-urgent items, so that I can batch them.
21. As a security-conscious administrator, I want messages to deep-link into a signed-in session that applies step-up rules, so that no approval happens from a message alone.
22. As an owner, I want the plan to show estimated cost and time per task and in total, labelled as estimates, so that I know the order of magnitude before confirming.
23. As an owner, I want the plan to state the budget ceiling that applies, so that I know the hard limit.
24. As an owner, I want every result to show its actual cost, so that estimates are held to account.
25. As an owner, I want a workspace daily/weekly spend cap that pauses work with a "paused: budget" item and a one-click raise, so that nothing runs away.
26. As a user, I want a "Repeat this" button on a finished mission, so that good work recurs.
27. As a user, I want to pick "every weekday 08:00" from presets with my timezone and see the next five occurrences computed by the server, so that I do not write cron.
28. As a user, I want each occurrence's result to show what changed since the previous one, so that I read only the difference.
29. As a user, I want a failed occurrence to pause or skip with a plain reason, so that a recurring job does not fail silently.
30. As a phone user, I want Today to start with "2 need you, 1 running, 3 done since yesterday", so that I get the state at a glance.
31. As a phone user, I want thumb-sized approve and reject buttons that show the exact digest, so that I can decide safely.
32. As a phone user, I want an install-to-home-screen prompt after my first completed mission and an app badge with the queue count, so that Brain stays within reach.
33. As an owner, I want to share a read-only, expiring link to one result with a stakeholder, so that they see it without a workspace account.
34. As a user watching a run, I want one plain sentence per active task such as "reading 4 sources", so that silence does not look like failure.
35. As a user watching a run, I want an ETA band from the plan's estimate versus elapsed time, so that I know when to check back.
36. As a user watching a run, I want Pause, Steer and Stop, so that I can take over.
37. As an auditor, I want a steer instruction recorded as a mission-brief constraint with actor and time, never a hidden prompt edit, so that steering is traceable.
38. As an owner, I want a Quality page with the share of tasks verified without human help, stall rate, re-open rate, cost per verified task, median time to first result and top failure reasons, so that I can tell whether Brain is improving.
39. As an owner, I want those numbers computed deterministically from existing records, so that I can trust them.
40. As an owner, I want re-opens and rejected sign-offs saved as cases in the evaluation set, so that real failures become regression tests.

## Implementation Decisions

- Today is a new workspace route and the landing target for the bare route. The current rule ("Live when sessions are active, Missions otherwise") becomes: Today when the decision queue is non-empty or nothing is active, Live when sessions are active and the queue is empty. The cross-workspace Bridge screen is unchanged.
- The "What do you want done?" box reuses `mission.create` with the Describe payload. The mode toggle is removed from the new-mission dialog; plays become chips. A default per-mission budget is applied by the Governor when the command carries none.
- Inline setup reuses the existing operational readiness read (checks carry an `action` and `nextAction`). Each check maps to a fix control that opens the existing Administration form in a sheet or deep-links with a return path. No new readiness logic.
- The sample goal is a catalog entry using an already-shipped workflow so it works before track A lands; it switches to the general workflow once that exists.
- The trust line is a deterministic read model over the stored verdict: per criterion the check basis is deterministic oracle (file/test/hash), human sign-off, or model opinion, plus independence level L1-L3. A criterion supported only by model opinion is Unverified and cannot make a task Done. This changes display and the done gate's acceptance rule, not the evaluator. Terms follow the GLOSSARY: verdict, independence level, evidence bundle.
- "Challenge this result" creates a reviewer pass whose output is stored as claims, never verdicts.
- "Result ready" is a new non-blocking attention item kind. GLOSSARY currently defines an attention item as something a human must act on, so the glossary entry and an ADR change first: the new kind means "something a human wants to know", sits below all blocking tiers, and widens the rule "only attention items notify".
- The decision queue is the existing attention list extended with inline actions that call the existing commands (approval decide, plan confirm, work-item sign-off). No new authorization: every inline action goes through the command funnel with the same scopes and step-up.
- Notification channels: a per-user preference record (channel on/off, digest on/off), delivery workers beside the existing push sender, the 15-minute per-mission throttle retained, approvals still bypass it. Webhook and email destinations are configured through Integrations; secrets never appear in payloads. Messages carry a link, not an action.
- Cost: plan tasks already carry optional estimated minutes and a per-task micro-USD cap; the plan view sums and labels them, and the Governor computes the ceiling from the mission budget. Actual cost per task is summed from settled session spend already tracked for the budget meter. A workspace spend cap is a new workspace setting enforced where mission budget is enforced; reaching it pauses with reason budget and raises the existing budget-pause attention item.
- Repeat: "Repeat this" creates an automation (existing scheduler, UF-12) targeting the finished mission's play or workflow; presets map to cron plus IANA timezone; the next-5 preview uses the existing server preview. Each occurrence's result is compared to the previous one by a deterministic text/table diff, not a model summary.
- Mobile: Today is responsive; the summary line is a deterministic count; approve/reject meet a minimum touch size; the app badge uses the Badging API where available; the install prompt follows the first completed mission. Read-only share links need an authorization decision (token type, scope, expiry, revocation) and are a separate, unready ticket.
- Live: "doing now" sentences derive from structured session events through the existing console activity summary; ETA is elapsed versus plan estimate. Pause maps to mission pause. Steer today is an advisory session control with at-most-once delivery; the new behaviour first records the instruction as a brief constraint through the mission brief edit command, then delivers it as the existing steer, so the record survives a lost delivery. Steering text is untrusted data.
- Quality: a deterministic, owner-scoped read query over missions, work items, verdicts, re-open events and settled spend. No prompt auto-tuning.
- Breaking changes are allowed (AGENTS.md): no shim for the old landing rule or the mode toggle.

## Testing Decisions

- Good tests assert external behaviour: what the user sees, which commands are accepted, which notifications exist, what read queries return. They do not assert component internals.
- Highest seam: the browser suite on a fresh instance for first-run, inline setup, queue actions, Repeat this, mobile viewport and Live controls; the Governor command/query API with a real store for trust line, notification rules, estimates, spend cap, repeat diff and Quality metrics.
- Prior art: existing browser tests, Governor integration tests for attention items and notifications, scheduler tests for UF-12, mission budget tests, and the AF-12 install verification.
- The trust line gets a table-driven test over combinations of check status, independence level and sign-off.
- Notification tests assert: blocking items notify within the throttle, progress never notifies, result-ready is non-blocking and opt-in per channel, the digest batches only non-urgent items, no secret appears in any payload.

## Out of Scope

- General workflow and planner assumptions (track A), Outputs, Logs, failure reasons and mission page (track B), Administration screens (track C), visual polish (track E).
- Automatic prompt rewriting or self-tuning.
- Slack or Teams apps beyond a generic webhook.
- Native mobile apps; the PWA is the mobile client.
- OpenTelemetry export.

## Further Notes

- Research caveats carry over: the Codex source was unreachable, and "no email/Slack delivery exists" came from a limited search, so the notification-channels ticket begins by verifying it.
- The backlog's "gaps 4-12" shorthand differs from the research file's numbering; this spec uses the research file's section numbers.
