# 43. Ready steps start together and the claim keeps the limits

Status: accepted, 2026-11-15. Spec #90, story 68. Builds on ADR 0019 (a step is not a job) and ADR 0020 (one run machine).

Admission started one step at a time: it stopped after the first step that was still running, so two steps with no need of each other ran one after the other.

## Decision
1. **One scheduler.** `admitReadySteps` (`workflows/admission.ts`) is the only place that decides which steps start. One pass admits every pending step whose needs have all succeeded, in the compiled order, and skips a pending step when a need failed or was skipped. A steer step finishes inside the pass and its dependents start in the same pass. A later rule (a `when` condition, ticket #125) is one more case of its readiness check.
2. **The limits stay at the claim.** Admission creates a queued job per ready step; it counts nothing. The mission's member cap and budget (ADR 0009, 0016) are applied when a runner claims, to open attempts, so a run with three ready steps and a cap of two shows two running and one `waiting: member cap`. Parallel steps are more jobs ready at once, never a way around admission. These jobs count in the workspace queue (ADR 0040) like any step's job and are never refused by it.
3. **The engine keeps a linear durable record.** The Mastra chain stays in compiled order and only records where a step waits. Mastra steps no longer admit anything: they apply the completion recorded for their own step (`engine_resumes`), else ask the scheduler (idempotent) and observe. A completion that arrives out of chain order waits in `engine_resumes` until the chain reaches its step; the data Mastra hands to a resume is ignored. Engine calls of one run are serialised.
4. **A failed branch stops the run (`failFast`).** The run fails at once and reports one failure; its pending steps are skipped and the jobs no runner holds yet are cancelled. A branch a runner already holds finishes, and its completion moves nothing. An approval decided after that changes nothing. The run is `suspended` while any gate waits and `running` again when the last one is decided.
5. **Recovery.** Brain's tables are the authority, so a restart loses no completion. A crash between a completion and the admission it unblocks is repaired by the maintenance pass: a running run with pending steps and nothing in flight gets `recoverRun`, which re-runs the scheduler; each job has one execution key per step, so no step starts twice.

## Rejected
- **Layered `parallel` blocks in Mastra.** A step graph is not layers; a block waits for its slowest member, which brings the serial wait back. Out-of-order completion on a linear chain costs nothing because Brain's tables decide readiness.
- **Counting the cap in admission.** A second place that knows the limit would drift from the claim.

## Limits
- A branch already running when its sibling fails is not interrupted.
- A step cancelled with its job stays `running` in the step list of a failed run, as after `workflow.cancel`.
