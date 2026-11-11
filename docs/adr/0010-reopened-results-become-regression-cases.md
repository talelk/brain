# 10. Re-opened results become regression cases, run before a release, never auto-tuned

Date: 2026-11-11
Status: Accepted (issue #64)

A rejected mission sign-off (which re-opens the mission) and a task sent back from review are the clearest real failures Brain sees. Until now they vanished into the event log. The open questions were where cases live, what a case holds, and what gate they feed.

**Storage.** A case is one immutable row in the workspace database (`eval_cases`), written in the same transaction as the transition that caused it, so there is no manual step and no lost case after a crash. It is idempotent per triggering event (`source` is unique: the rejected bundle digest, or the work item and its version). Cases stay with the workspace data; they are not committed to the repository, because they quote customer plans and findings.

**Format.** `brain.eval-case/v1`: kind (`rejected-verdict` or `task-sent-back`), mission title and intent, success criteria, the plan tasks (title and criteria), the reviewer's findings, and the digests of the final deliverables that existed at that moment. It is built from the stored plan version and verdict only: never transcripts, handoff notes or messages (the same rule as capitalization). Digests pin the exact deliverable without copying it.

**Where the suite runs.** In the release process, not in CI and not at run time. `evalCases.list` returns the cases (any workspace member can read their own workspace's), and `scripts/qualification/task-quality.mjs --cases <file>` replays every case task through a real model and the pinned deterministic validator beside the built-in samples. It needs a real model, so it is a manual pre-activation check, like the rest of that script. A release whose pass rate drops against the previous release is a reason not to activate it; the decision stays with a person.

**No automatic tuning.** Nothing reads a case and changes a prompt, workflow, policy or release. A case has no write path into configuration. Tests assert that recording cases creates no config draft or release.

Rejected: committing cases to `tests/` (leaks workspace content into the repository, and needs a human to file each one); a runtime "learned prompt" (unreviewed behavior change, against the product's rule that a model opinion never changes governance).
