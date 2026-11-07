# Mastra durable suspend/resume and plan changes mid-workflow

Research for [#20](https://github.com/talelk/brain/issues/20) (part of map [#6](https://github.com/talelk/brain/issues/6)). Date: 2026-11-07.

**Versions checked:** `@mastra/core` 1.79.0 and `@mastra/libsql` 1.27.0. These are the versions pinned in `apps/governor/package.json`, and the installed copies were read under `apps/governor/node_modules/@mastra/{core,libsql}`.

**Sources.** I used two kinds of high-trust source:
- The docs bundled with the package, at `@mastra/core/dist/docs/references/*.md`. They match 1.79.0 exactly. Each bundled page names its canonical mastra.ai URL, which I also give. The live site tracks the latest release, not 1.79.0.
- The compiled source in `@mastra/core/dist` and `@mastra/libsql/dist/index.js`. Chunk filenames are content-hashed, so the citations name the function as well as the file.

**Marking.** A claim marked *(source)* was read in the code. A claim marked *(docs)* comes only from the docs. Anything not verified says so.

## Short answer

| Question | Answer for 1.79.0 |
|---|---|
| Does suspend/resume survive a process restart? | **Yes, for `suspend()`.** The snapshot is persisted in the `mastra_workflow_snapshot` table. After a restart you re-register the *same* workflow id, call `createRun({ runId })` and then `resume()`. |
| Can a run wait on an external event without holding resources? | **Yes, but only with `suspend()` plus an external `resume()` call.** There is no event primitive: `waitForEvent` and `sendEvent` were removed in v1. `sleep` and `sleepUntil` are in-process timers and are not durable in Brain's embedding. |
| How long can a run stay suspended? | **I found no limit in the docs or the source.** Snapshots are kept until deleted, and retention is opt-in and inactivity-based. Brain configures no retention. |
| Can a running or suspended run absorb a changed graph? | **No, there is no supported way.** A run executes the graph of the workflow object it was created from. A changed plan has to become a **new run**. |

## 1. Durable suspend/resume across a process restart

**What the docs say.** "Suspension saves the current execution state as a snapshot … Snapshots are stored in your configured storage provider and persist across deployments and application restarts." *(docs)*
- Source: `docs-workflows-suspend-and-resume.md` (<https://mastra.ai/docs/workflows/suspend-and-resume>).

**Where the snapshot is stored** *(docs + source)*
- Snapshots go in the table `mastra_workflow_snapshot`, defined as `TABLE_WORKFLOW_SNAPSHOT` in `core/dist/constants-*.js`.
- The table has the constraint `UNIQUE (workflow_name, run_id)` (`libsql/dist/index.js`, table creation).
- The snapshot is written as `jsonb(?)` with an `ON CONFLICT(workflow_name, run_id) DO UPDATE` upsert, inside a libSQL write transaction (`WorkflowsStorage.updateWorkflowResults` and `updateWorkflowState`).
- The connection sets `PRAGMA journal_mode = WAL` and `busy_timeout = 10000`.
- The snapshot contains:
  - the step context: per-step status, outputs, and suspend and resume payloads;
  - `suspendedPaths`, which are positional execution-path indices;
  - `activeStepsPath`;
  - a `serializedStepGraph`;
  - `requestContext` and state.
- Docs: `docs-workflows-snapshots.md` (<https://mastra.ai/docs/workflows/snapshots>).

**How to resume after a restart** *(docs + source)*
1. `workflow.createRun({ runId })` loads the stored status (`Workflow.createRun` in `core/dist/agent-*.js`).
2. `run.resume({ step, resumeData })`.

The recovery helpers `getWorkflowRunById()` and `createWorkflowStateReader()` are documented under "Recovering suspended runs".

**Resume checks.** `Run._resume` *(source)* does the following:
- It loads the snapshot keyed by `(workflowId, runId)`.
- It throws `WORKFLOW_RUN_NOT_SUSPENDED` unless the status is `suspended`.
- It verifies that the target step is in `suspendedPaths` and validates `resumeData` against the step's `resumeSchema`.
- It claims the run with a status compare-and-swap from `suspended` to `running`.

**Early-wake window** *(source)*
- `waitForSuspendedSnapshot` (`core/dist/resolve-agent-*.js`) polls every 25 ms for at most **2 s** (`RESUME_SNAPSHOT_POLL_TIMEOUT_MS = 2e3`) while the snapshot is still `running` or `pending`. After that the resume fails.
- So a completion that arrives before the step has suspended is **not** buffered by Mastra.
- Brain's `engine_resumes` table and the `readResume` fallback in `apps/governor/src/modules/workflows/mastra/engine.ts` exist to close this gap.

**Running or waiting runs are not recovered in Brain's embedding** *(source)*
- Docs: `docs-workflows-overview.md`, "Restarting active workflow runs".
- `Mastra.restartAllActiveWorkflowRuns()` re-drives runs whose status is `running` or `waiting`. It does not touch `suspended` runs, which only need `resume()`.
- The default `recovery: { workflows: 'auto' }` means "the **server** calls" the sweep on boot (`core/dist/mastra/index.d.ts`, the `MastraRecoveryConfig` JSDoc). Nothing in `@mastra/core/dist` calls it: the `Mastra` constructor does not.
- Brain builds a bare `new Mastra({ storage })` and runs no Mastra server. `apps/governor/src` never calls the sweep.
- **Consequence:** in Brain, a Mastra run that was mid-step (`running`) when the process crashed stays `running` in `mastra.db`. Mastra does nothing to recover it.
- This is mostly harmless today, because Brain's own rows (`workflow_runs` and `workflow_steps`) are authoritative and every effecting step suspends almost at once. It is still a gap against the "same-version crash/restart recovery" requirement if any Mastra step does real work before it suspends.

**Mastra and Brain state are stored separately.** `mastra.db` (under `<dataDir>/mastra`) and Brain's workspace databases are separate SQLite files, and no transaction spans the two. Brain must remain the authority and treat Mastra state as rebuildable progression state. The current engine already does this.

## 2. Waiting on external events without holding resources

- **`suspend()` is the mechanism.**
  - The v1 migration guide says: "The `waitForEvent` API has been removed from workflows. Use the suspend/resume API instead." The same applies to `sendEvent`.
  - Source: `reference-migrations-upgrade-to-v1-workflows.md` (<https://mastra.ai/reference/migrations/upgrade-to-v1/workflows>).
  - `resume()` "can be called from anywhere in your application, such as an HTTP endpoint or event handler" *(docs)*.
- **A suspended run holds no timers or connections, but does hold some memory.**
  - The state lives in storage.
  - In-process, `Workflow.createRun` caches the `Run` in a private `#runs` map. Its `cleanup` is skipped while the status is `suspended`, so the `Run` object stays in memory until the run finishes *(source: `Run._resume` `.then` handler)*.
  - Brain's `MastraWorkflowEngine.runs` map never evicts either.
  - So long-lived suspended runs cost memory per run inside one process, but no other resources. The cost resets when the process restarts.
- **`sleep` and `sleepUntil` are not durable here.**
  - In the default engine, `executeSleepDuration` and `executeSleepUntilDate` call `abortableSleep`, an in-process `setTimeout` *(source: `core/dist/agent-*.js`)*.
  - They set the run status to `waiting`. Only the restart sweep would re-drive such runs, and Brain doesn't run the sweep (see section 1).
  - Not verified: whether a restarted `sleep(ms)` restarts the full duration.
  - **Conclusion:** don't use Mastra `sleep` or `sleepUntil` for mission-level waits in Brain.
- **Out of scope.** Durable timers or events would come from the evented engine, schedules (`docs-workflows-scheduled-workflows.md`) or an Inngest-style engine. None of these is wired into Brain, and I did not evaluate them.

## 3. How long a workflow may stay suspended

- **I found no expiry, TTL or timeout on a `suspended` snapshot** in the 1.79.0 docs or in the `_resume` and `createRun` code paths. The only time bound in the resume path is the 2 s early-wake poll from section 1.
- **Storage keeps rows forever by default.** "Unconfigured data is kept forever." *(docs)*
  - Retention is opt-in through `LibSQLStore({ retention })` together with an explicit `storage.prune()`.
  - For `workflows.workflowSnapshot`, the key is `updatedAt`, described as "Inactivity, suspended or long-running workflows survive".
  - Source: `reference-storage-retention.md` (<https://mastra.ai/reference/storage/retention>).
  - Not verified in source: whether `prune()` actually exempts suspended snapshots. Brain configures no retention, so it doesn't apply today.
- **Practical limits are operational, not built into Mastra:**
  - the database file grows;
  - the in-memory `Run` cache grows (section 2);
  - the workflow id must still be registered at resume time.

## 4. Can a running or suspended run absorb a changed graph?

**No.** A changed plan has to become a new run.

- **Mechanism** *(source)*
  - `Workflow.createRun` constructs the `Run` with `executionGraph: this.executionGraph` and `serializedStepGraph: this.serializedStepGraph`, taken from whatever workflow object `createRun` was called on.
  - `Run._resume` runs `graph: this.executionGraph`, using `resumePath: snapshot.suspendedPaths[step]` and `stepExecutionPath` from the stored snapshot. These are positional indices into the graph.
  - The snapshot's own `serializedStepGraph` is not used to rebuild the graph, and nothing checks the stored graph against the current one at resume. (Time travel does check: see `assertTimeTravelGraphMatchesSnapshot` below.)
- **What the docs say about dynamic workflows** *(docs)*
  - "Add a new definition with the same `id` to replace … New runs use the updated graph. Runs that already started continue with their original graph." The `addDynamicWorkflow` reference adds "In-flight runs keep the graph they started with."
  - Sources: `docs-workflows-dynamic-workflows.md` (<https://mastra.ai/docs/workflows/dynamic-workflows>) and `reference-core-addDynamicWorkflow.md`. The feature is marked **Beta**.
  - In the source, this guarantee comes from the in-process `Run` cache.
- **After a restart (inferred from source, not tested)**
  - Suppose a *different* graph is registered under the same workflow id. `createRun({ runId })` plus `resume()` would then execute the new graph from the old positional paths. That would be silently wrong, not rejected.
  - **Treat in-place graph replacement under a stable id as unsupported.**
- **Time travel does not cover this either.**
  - `run.timeTravel()` re-executes from a chosen step, but "If the workflow definition has changed since the run was recorded … time travel fails with a descriptive error" *(docs: `docs-workflows-time-travel.md`, <https://mastra.ai/docs/workflows/time-travel>)*.
  - The source has `assertTimeTravelGraphMatchesSnapshot`.
  - It is a debugging and recovery tool, not plan migration.
- **What Brain does today.**
  - The Mastra workflow id is `${metadata.id}-${workflowDigest.slice(7,19)}` (`ensureWorkflow` in `engine.ts`).
  - The graph is lowered from the run's stored `run_inputs.workflow_json`.
  - So each Brain run is pinned to its exact plan version, and it rehydrates against that same graph after a restart. A plan change can't reach an existing run, and the only path is a new run. That fits the immutable run and evidence references required in `AGENTS.md`.

## Implications for "missions advance on events and are never a run"

- **Use Mastra only as a durable executor for one fixed, immutable plan version.** One Brain workflow run maps to one Mastra run, pinned by digest.
- **The Governor should own mission-level waiting and advancement:**
  - event subscription and matching;
  - timers;
  - plan versioning;
  - choosing when to start the next run.
- **Mastra has no durable event primitive or durable timer** in Brain's embedding, and it cannot migrate a running graph.
- **A mission plan change becomes new runs, never a mutation of a live run.** Cancel the superseded run, or let it finish, and then start the next one with explicit lineage from mission to runs.
- **A long-lived Mastra suspension is technically fine.** There is no TTL and no held timers. Its costs are a `mastra.db` row and per-process `Run` memory.
- **Mastra suspension still doesn't model a mission.** Missions should not be long-lived Mastra runs.
- **The current engine design already matches this split.** Brain rows are authoritative, `engine_resumes` buffers early wakes, and runs are digest-pinned. Two follow-ups are worth noting:
  - running or waiting Mastra runs are not swept after a crash (section 1);
  - the `runs` maps in Brain and Mastra never evict suspended runs (section 2).

## Not verified

- What a restarted `sleep(ms)` does after `run.restart()`: whether it restarts the full duration.
- Whether `storage.prune()` really exempts suspended snapshots. Only the docs table was checked.
- Behaviour after a restart when a different graph is registered under the same id. Inferred from source, not run.
- Whether the evented engine, schedules or the workers fit Brain. Not evaluated.
