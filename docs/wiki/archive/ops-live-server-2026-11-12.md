# Live server operations: dated notes of 2026-11-12 (archived from ops-live-server.md)

- 2026-11-12: Tools tab now has Recent calls and why they failed (`tools.calls`, deployed); failed script calls keep their own reason (`tool exit N: reason`). Editing a tool from the UI is blocked: no git write binding on the live server (see backlog).
- 2026-11-12: SRE report task parked after 3 failed attempts pinned to the old release (32k token limit; they used 44-59k); retried on the 100k release and finished first try. A parked task keeps its old pin until retried.
- 2026-11-12: Tools tab has Edit this tool: a Studio draft with the definition, script and schemas; dependents (agent, workflow) are re-pinned at validate/publish (`repin.ts`); active tool scripts are addressed `tools/<id>/<entrypoint>` (bare `run.sh` collided across tools). Publishing needs a Git write binding (decision: keep Git).
- 2026-11-12: Tools tab has Try this tool: `POST /v1/config/tools/:id/test` runs a read tool as a one-step workflow `tool-test:<id>` (runner group agents), recorded in `tool_test_runs`, never in `tool_calls`; brokers apply (Governor read broker allows the test's own tool; allowed hosts come from the pinned definition via the offer).
- 2026-11-12: parked work heals once per activated release (`parked_auto_retries`); a parked task can be re-planned (the started-work guard exempted parked items, which had made Edit/Reassign always fail) and Run this task with picks another recipe.

- First weekly run found real inventory gaps (stale Gatus checks for `sf1prod`, `nouvelair-m`, `autorobot`); fixed.

- (2026-11-11) The live release catalog then held only two workflows (`operations-triage` takes `{situation}`, `support-draft`), pinned by digest.
