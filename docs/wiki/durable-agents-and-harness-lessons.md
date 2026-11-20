# Lessons from two articles: a durable software factory and a self-improving harness

Adopted with the owner after two articles (Nov 2026). This page keeps the references, what Brain took from each, what it did not, and the working loop that results.

## References

- David R. Oliver, "I Built A Software Factory — A Guide To Durable AI" (Medium, 2 Nov 2026). Code: <https://github.com/DavidROliverBA/durable-factory>. Built on Durable Pi, <https://github.com/disler/durable-pi>, itself on Pi Durable (the Pi coding agent's team). Its workflow follows a small project, agent-factory.
- Gao Dalie, "Forget Harness Agent. Recursive Agent Harness² 10x Better" (Medium, Data Science Collective, Nov 2026). It reports Google Research and Northwestern University's open-source "Harness²" (Oct 2026); the article gives no repository address, and its numbers (WorkBuddy-Bench 64.2 to 75.7 for GLM-5, JobBench, LAB) come from the article, not from a run of ours.

Mitchell Hashimoto's "harness engineering" (Feb 2026) is the idea both build on: when an agent errs, fix the environment and tools so that the error cannot happen again, rather than the prompt.

## What Brain took

| Idea | Where it is in Brain |
|---|---|
| Check an agent's report against ground truth, in code (the factory compares the report with git) | `reportProblem` in `apps/governor/src/tasks/orchestrator.ts`: a file the result says it saved under `/out` that the attempt did not keep, or a file in `/work` outside a project, goes back as a failed round with the reason. No reviewer is asked. |
| "I cannot do this within the rules" is a valid answer | A result that starts with `BLOCKED:` goes back with its reason (a round, then a person). Every task text says so. |
| Tell the rules and enforce them: both | The task text says where the agent is and what is kept; the planner's `needs` are enforced by `readPlan` (an agent that lacks one is replaced). |
| Bounded loops, a human at the decision, a wait that is durable | Already Brain's: rounds, attempts (13 tries), reviewer stagnation, approvals, the queue. |
| A budget that stops a run before the next turn | Already Brain's: agent limits and `daily_spend_usd`. |
| Pull the plug on purpose, then expect the same result | Not yet: see "Not taken". |
| Failure traces become a reusable fix and a lesson (Harness²: suggest, verify against the baseline trace, synthesise, reflect into `EXPERIENCE.md`) | The healer proposes `workspace.fix` for an admin and, in the same fix, a memory entry `memory/heal-<cause>.md` with the symptom, cause, change and the condition under which it applies again. The next heal searches them. |
| Keep when a change helps, not the whole setup | The lesson's condition, as above. |

## Not taken, and why

- **Durable Pi itself** (a logbook that resumes an agent session after a crash): not added, because it is not needed yet. Brain's attempts are bounded by turns, tokens and time, and a lost one is tried again (a lease lost or a dropped model connection is infrastructure, for about six hours); no failure of this project came from a crash. Adopting it means patching Pi, as its own setup does, and a second durable store beside the Governor's SQLite file; its code was not read for this page. If a retried attempt proves costly, a lighter step comes first: keep Pi's own session file (the runner removes it with the attempt's folder at the end of each try) and open it again on the next try of the same attempt.
- **Harness² recursion**: candidate generation and verification multiply the model cost, and its gains are reported on benchmarks that are not Brain's. The healer already follows the first half (trace to proposal); verifying a proposal against the baseline before an admin sees it is the next step, not done.
- **A crash test that kills the runner five times in one run**: the factory's strongest proof. Brain's lease and retry rules are tested one at a time; a single end-to-end kill-and-resume test is left to do.

## The loop

1. A goal gets a plan whose tasks name their `needs`; each goes to an agent that has them.
2. An attempt works, with its folders and rules in its task text.
3. Brain reads the report (blocked, or a lost file) before any reviewer.
4. A reviewer, other than the author, checks; two near-identical verdicts end the rounds.
5. A failure of the infrastructure is tried again for about six hours; any other failure that ends all attempts is healed once.
6. The healer proposes the fix with its lesson; an admin approves; the lesson is searched by the next heal.
