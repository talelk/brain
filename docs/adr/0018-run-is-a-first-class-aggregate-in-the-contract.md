# 18. Run is a first-class aggregate in the contract

Date: 2026-11-11
Status: Accepted (issue #3).

**Decision.** `Run` is a DTO in `brain.schema.json` (`runId`, `organizationId`, `workspaceId`, `release`, `configDigest`, `state`, `version`, `createdAt`, `inputDigest`, optional `outputDigest`, `missionId`, `workItemId`). `RunId` is its identifier type; every `runId` field and `workflowRunId` field references it. `readRun` in `modules/workflows/run.ts` is the one place that builds a `Run` from storage. `outputDigest` is the outputs reference (run outputs are immutable and digest-addressed).

**Storage mapping, no migration.** Tables and persisted JSON keep their names: `Run` maps to `workflow_runs` (+ `run_inputs` for the release id, `execution_links` and `mission_runs` for the links); `workflow_steps` holds a run's step rows. `workflowRunId` stays the field name inside evidence manifests (digested, queried with `json_extract`), attempt offers and job rows (`workflow_run_id`); only its type is `RunId`. Renaming those would change immutable digests.

**Rejected.** Leaving the glossary as the only definition: consumers had to reconstruct the concept from field names.
