# 20. One run state and one run machine

Date: 2026-11-11
Status: Accepted (issue #5).

**Decision.** `WorkflowState` and `WorkflowRunState` collapse into `RunState`, used by the `EngineAdapter` port and `JobSnapshot.runState` (was `workflowState`; a computed read-model field, not persisted). The state machine in `state-machines.json` is renamed `workflow` to `run` and is the single definition; `tests/domain/states.test.ts` asserts the schema enum equals the machine's states. The `workflow_runs.state` CHECK list is unchanged.
