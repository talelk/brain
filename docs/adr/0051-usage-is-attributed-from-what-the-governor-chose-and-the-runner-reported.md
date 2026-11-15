# 51. Usage is attributed from what the Governor chose and the runner reported

Date: 2026-11-15
Status: Accepted

Extends ADR 0009. Each ledger row (`mission_spend`, `workspace_spend`) also names the team member, agent
definition, engine and model of its attempt, so cost can be split without changing any total.

- Agent and member are the Governor's own facts, stamped when the attempt is reserved at claim: the agent is
  the release the job's pinned payload runs, the member is the one the session's machine principal is bound
  to (ADR 0032). A reassignment later cannot move spend, and nothing the model says is read.
- Engine and model are what the runner reported for that attempt (the `engine` object of its event batches,
  kept once on `job_attempts`), copied to the row at settlement. An engine that names no model (an ACP
  agent picks its own) leaves it empty: no placeholder is filled in (ADR on observed-only runner facts, #105).
- The advisory judge's calls (#95) are rows with `source = 'judge'` and the hosted model; they have no
  agent, member or engine and are never mixed into "not reported".
- Every grouping covers each row once, so groups sum to the total on every figure; totals and de-duplication
  by usage id are untouched. Scopes `agent` and `member` read the same rows (`usage.agent`; `usage.member`
  keyed `<missionId>:<memberId>`, because member ids are a plan's own labels).
