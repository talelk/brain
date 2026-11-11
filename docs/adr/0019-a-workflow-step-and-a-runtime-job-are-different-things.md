# 19. A workflow step and a runtime job are different things

Date: 2026-11-11
Status: Accepted (issue #4).

**Decision.** The declared node is a *step*: `WorkflowJob` is now `WorkflowStep`, and `DispatchJob`, `GateJob`, `EvalJob`, `SteerJob`, `MergeJob`, `SubgraphJob` are `*Step`. Governor locals that hold a declared node, error messages and Studio labels ("Visual steps", "Step id", "Add step") say step. *Job* means only the runtime unit in the `jobs` table.

**Persisted names that stay.** The definition key `spec.jobs` (and `WorkflowIR.jobs`), and binding `source: "job"` / `jobId`, are inside released, content-addressed documents and stored `run_inputs.workflow_json`; renaming them changes release digests and breaks live data, and aliases are out of scope. They are the one place where "jobs" still names steps; the Studio says so.

**Rejected.** Renaming `spec.jobs` to `spec.steps` now: requires a data migration and re-release.
