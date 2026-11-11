# 6. A zero per-attempt cost cap means unbounded

Date: 2026-11-11
Status: Accepted

Agents declare `maxMicroUsd: 0`, and the policy floor reports 0 when no layer sets a cap.
The Claude and Pi engines skipped the SDK cap at 0 but their post-run check failed any
attempt whose cost was above 0, so every starter run failed on a paid endpoint.

Decision: `maxMicroUsd: 0` means "no per-attempt dollar cap". Engines enforce the cap only
when it is positive (`overCostCap`, shared by both adapters). For work inside a mission, spend is
bounded one level up: the mission budget with its per-attempt reserve, the optional mission token
ceiling and the workspace spend cap all stop admission before a new attempt starts. An interactive
run outside a mission is bounded only by its token limit, turn limit and timeout (it has no mission
budget or ledger row, see ADR 0007); set a positive `maxMicroUsd` on an agent that interactive users
run against a paid endpoint. Token limits are unchanged: `maxTokens` always has a positive default
and is always checked.

Safest default because a cap that silently equals "forbid all paid usage" turns a missing
setting into outright failure, while an unbounded mission attempt is already bounded by the
budgets above and by the attempt timeout. Operators who want a hard per-attempt cap set a
positive `maxMicroUsd` in the Agent document.

Rejected: 0 = no paid usage with explicit caps on every starter agent (every deployment
would need edits to run, and the caps would be guesses).
