# 41. Priority orders work inside a workspace's fair share, never across workspaces

Status: accepted, 2026-11-15.

Work items gained a priority (urgent, high, normal, low), but `jobs.priority` was sorted on at claim time and never set. The claim also took mission turn-taking (#36) before anything else, so two missions of one workspace were ordered by who ran least, not by what mattered.

## Decision
1. A work item's priority is written into the job priority (low 0, normal 1, high 2, urgent 3) when a job is created: through the run it was dispatched for, so the first job already carries it, and for a held act job from the job that proposed it. A run for no work item is normal. A change a person makes reaches the run's later steps and its jobs still waiting for a runner.
2. The claim orders candidates by: the workspace with the fewest attempts in flight, then the higher priority, then interactive work before missions, then missions by fewest running, then age. Fairness between workspaces stays first, so inflating priority never lets one workspace take another's turn.
3. Candidates are read per workspace, best first. A global read ordered by priority hid a quiet workspace behind another's hundreds of queued urgent jobs.
4. A due date flags an open item overdue on read. It is no attention item and sends nothing: the glossary allows one non-blocking attention item, and a date passing is not news a person must act on.
5. Priority orders work and does not touch the Done rule (ADR 0022): an urgent task still needs verified evidence.

## Consequences
- Mission turn-taking now breaks ties inside one priority of one workspace; it no longer outranks priority or workspace fairness.
- Auto-start picks ready tasks by priority, then age, when a mission can run only some of them.
- A person sets priority (an agent cannot raise its own), through `workItem.details.set`.
