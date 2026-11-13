# 22. A task that declares required tools is Done only with observed evidence

Status: accepted, 2026-11-13.

On the live `sre-demos` workspace a mission whose tasks all reported "I could not see any containers" closed achieved, because each answer met its criteria as written. Brain then published it as Approved knowledge. The independent check judged the form of the answer, not whether anything was observed.

## Decision
1. **A task may declare the tools it needs** (`requiredTools`, already checked at plan time against the agent's tools). For such a task, Done requires at least one successful recorded call of one of those tools in the run.
2. **The Governor decides this from the call record, never a model.** The evaluator model cannot argue it away.
3. **Without observed evidence the check fails.** The task follows the existing path: another attempt, then a Parked work item for a person. No new task or run state is added (ADR 0020).
4. **Capitalization writes up only missions whose criteria rest on observed evidence.** A criterion met only by the worker's own statement stays a claim and is not published as knowledge.

## Considered options
- A new terminal outcome, "Could not do", beside Done and Parked. Rejected: Parked already means waiting for a human, and a new state reaches every screen, state machine and count.
- Let the evaluator model judge whether anything was observed. Rejected: it shares the worker's model and its blind spots.

## Consequences
- Tasks that declare no required tools keep today's check. How a task comes to declare them (the planner, a way of working, or a workspace default) is a separate decision; until it is made, the rule does not protect a task that declared nothing, which is how the Docker task slipped through.
- The Done rate falls at first. That is the honest number appearing.
- The knowledge entry that triggered this must be withdrawn by hand.
