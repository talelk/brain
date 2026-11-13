# 22. A task that declares required tools is Done only with observed evidence

Status: accepted, 2026-11-13.

On the live `sre-demos` workspace a mission whose tasks all reported "I could not see any containers" closed achieved, because each answer met its criteria as written. Brain then published it as Approved knowledge. The independent check judged the form of the answer, not whether anything was observed.

## Decision
1. A task may declare the tools it needs (`requiredTools`, already checked at plan time). For such a task, Done requires at least one successful recorded call of one of them.
2. The Governor decides this from the call record, never a model.
3. Without it the check fails and the task follows the existing path: another attempt, then a Parked work item. No new state is added (ADR 0020). A "Could not do" outcome was rejected: Parked already means waiting for a human.
4. Capitalization writes up only missions whose criteria rest on observed evidence.

## Consequences
- A task that declares no required tools keeps today's check, which is how the Docker task slipped through. How tasks come to declare them is a separate decision.
- The Done rate falls at first: that is the honest number appearing.
