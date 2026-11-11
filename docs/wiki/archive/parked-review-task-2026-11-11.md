# Parked review task on the live demo (2026-11-11)

Mission `mission-mwbd8had-d-7u9bmja5`, task "Independently review the guide..." (workflow `general-task`) parked after 3 failed attempts. Diagnosed read-only from the live databases, attempt events and runner journal, against release code `talelk/brain@cd3f43f`.

## Evidence
- Attempt 1 (`run-mwbdchm8-29-7u23vywq`): the Pi engine used its whole 8192-token output cap (`outputTokens: 8192`, output 0 bytes) without writing an answer, so the runner reported "agent completed without output". Not a deploy interruption: the runner journal shows restarts at 00:11, 00:12 and 00:24 only, and the attempt ran 00:16:32 to 00:19:22.
- Attempts 2 and 3 (`run-mwbdg82i-2h-4s6r34y2`, `run-mwbdhej0-2t-g4m27ay3`): the model produced a well-formed report (about 7 KB) and the `task.validate` check `criteria-met` failed while `structure`, `safety` and `deliverable` passed. The model had set `met: false` on the criteria the reviewed guide did not satisfy ("No step assumes access ...", "Every item ... independently checkable"). A review that finds a defect was counted as a failed task.
- The reviewer only had the upstream summary, so it wrote that "the actual file was not directly read".
- The parked reason shown was only "Step respond failed".

## Fixes
See the commits that follow `cd3f43f`: criteria rows matched by normalised wording (reworded rows accepted by position), review criteria written about the review's own output (plan guide) and `met` defined for review tasks (worker), larger Pi output cap and a plain message when the model spends it thinking, upstream deliverable excerpts in the brief, a plain failure reason on the parked item, and agent or evaluator jobs interrupted by a restart re-queue without counting as a failed attempt (at most 5 attempts per job). Measure a real model with `node scripts/qualification/task-quality.mjs`.

## Live release
Agent, schema and workflow documents changed, so digests change: the live release must be re-staged and activated (see `ops-live-server.md`, `docs/howto/compile-activate-release.md`), then the governor and runners restarted.
