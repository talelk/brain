# Plan drafting: failures and latency, measured live (2026-11-11, track Q)

Read-only from the live databases (`planning_requests`, control `jobs`/`job_attempts`/`attempt_events`, workspace `plan_versions`), against release code before this change (`talelk/brain@7471413`).

## Findings
- "Proposal: revision 2" is not a retry. Revision 1 is the Play's own `template` draft, revision 2 the agent's draft. Missions `mwbxiijh` and `mwbyju6c` each had one propose job, one attempt, validated first time.
- Of 10 propose runs ever, 2 failed, both on mission `mwbb6zis` (2026-11-10 23:16 and 23:17, before `knowledge.search`). Same shape both times: `assignment: {kind: "human", role: "reviewer"}` with no `id`. The Governor's output-schema check (and the plan validator) require `{kind,id,role}`, so the job failed after the model finished. The automatic retry got the same input and repeated the mistake; the third run (started by hand) passed. The last 7 runs all passed first time.
- Latency, run `mwbyjuwe` (64 s): engine start 9 s, first model turn 10 s then one `knowledge.search` call, tool round trip 5 s, second model turn 20 s before the first token, writing the 1,700-token JSON 20 s, check job and polling about 6 s. `mwbxizxz` took 71 s. Before `knowledge.search` plans took 15-35 s. Input tokens went from about 600-1,000 to 3,700-4,800. Every run made exactly one tool call, so there is no tool loop to cap; the cost is the extra model turn.

## Changes
- The Governor looks up stored knowledge once (the memory search the tool used) and hands up to four bounded, labelled hits to the planner as `related`. The plan guide has no tools and `maxTurns: 2`; one model session per plan.
- Agent jobs carry their output schema. The runner's one corrective session (before: only for unparseable JSON) now also runs for a reply that breaks the output contract and names the exact violations (for example `/tasks/0/assignment must have required property 'id'`), inside the same attempt. A correction that is worse is dropped. Both sessions are charged.
- The plan guide prompt says a human task uses assignment id `owner`, and otherwise to leave assignment out.
- `MissionPlanView.stage` (`reading`, `drafting`, `checking`) is derived from the run's jobs so the UI can show honest progress.
- `node scripts/qualification/task-quality.mjs --plans N` measures first-try and corrected success and seconds per draft on a real model.

## Live release
Agent, workflow, input schema and prompt changed (`releases/cv-insights` regenerated): after deploy run `scripts/stage-demo-release.sh`, then wait about a minute.
