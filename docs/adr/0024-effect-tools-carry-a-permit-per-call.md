# 24. Effect tools carry a permit per call

Status: accepted, 2026-11-13. Builds on ADR 0021 (host access is read-only until this).

An agent may now change things outside Brain (restart a container, reload a service, create a ticket, send a message, open a pull request). Authority to do so is never standing.

## Decision
1. **An effect tool is a Tool with effect class `write` or `privileged`** and an operator-owned policy in the Governor (`governance/effects.ts`): what the call touches, the plain-words summary the owner reads, and the check of its arguments. A Tool document or a model cannot widen the policy.
2. **Each call stops at a gate.** The runner proposes the call; the Governor checks the tool (pinned, in the agent's allowlist, declared non-read), the arguments (a container or service must be on the workspace's allow-list, set by `workspace.effects.set`), the runner group and that the connector exists; then records an approval whose subject is that exact call (tool, arguments digest, target, attempt, proposal). The requester is the platform (`system:effect-call`), so the owner can decide their own mission's call, from a phone, on the approval's page; approvers are notified with a link to that one decision. Approval needs step-up as always.
3. **One permit per approval, single use.** An approved call yields one permit (`effects/permit`), consumed by `effects/start` (state `issued` to `started`, atomic). Other arguments, another tool, another attempt, a replay or an asked-twice permit are refused. The runner re-validates the permit just before the work, then reports `applied`, `absent` or `unknown` with a receipt artifact; the Governor records the receipt and the evidence bundle carries the effect and the consumed approval. An `unknown` outcome blocks verification and is never retried.
4. **Denial or expiry fails the call** with a plain reason and changes nothing; the agent is told not to retry.
5. **Work is done by a broker.** Host changes are named privileged commands of the operator's file on the trusted launcher (`docker.restart`, `service.reload`); the launcher also keeps a single-use ledger of invocation ids, so even a replayed request cannot run twice. Ticket, message and pull request run in the Governor behind ports (`TicketPort`, `MessagePort`, `PullRequestApi`): credentials never reach the sandbox, a model, an event or an artifact.
6. **A dedicated runner group** (`runnerGroup.set`): a group with a row takes only its listed workspaces; an agent whose tools include `host.*` is offered only to a group marked for host tools; the Governor refuses a host effect from any other group. The starter release declares the group `sre-host`.

7. **Scheduled watches propose and act through the same gate.** A scheduled workflow (`automation.upsert`) or a Repeat mission runs the watch; its agent step is class `read`, so auto-confirm (ADR 0017) is unchanged, and each change it proposes stops at its own approval. An earlier approval buys a later occurrence nothing.

## Why not hold the attempt's approval outside the runner
While an approval waits, the call holds a runner slot and the attempt's lease and counts as working time (ADR 0016). We accept it for now: the wait is outside the engine deadline, the host group is dedicated, and the approval expires (default 30 minutes, 1 to 1440). A held "act" job that runs after the decision, so nothing waits on a runner, is a backlog row.

## Limits
- Workflow steps of class `write` or `privileged` still use gate approvals and their own permit path; this decision covers calls an agent proposes.
- Output of a host change is redacted by pattern like `host.exec`.
