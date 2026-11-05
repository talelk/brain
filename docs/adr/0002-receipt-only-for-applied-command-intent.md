# 2. A command receipt exists only for an applied command intent

Date: 2026-11-05
Status: Accepted

## Context

The command funnel committed the idempotency receipt (outcome `queued`) inside
the control.db transaction and ran the owning module's effect afterwards, in a
`postApply` step outside that transaction. The split existed to keep the
control transaction short, because workspace effects live in separate
per-workspace SQLite files and cannot share a transaction with control.db.

The consequence was silent loss: when the effect threw, the client saw an
error, but the receipt was already stored. A retry with the same idempotency
key was answered as a replay — 202, no resource — and the effect never ran.

Three paths (workspace commands, organization administration, human approval
decisions) also each wired the receipt envelope themselves.

## Decision

One command funnel owns validation, authorization, idempotency and commit for
every command path. Modules register a handler per command type.

- The funnel records a **pending** command intent, runs the handler, then
  commits the receipt and marks the intent **applied**. A handler that throws
  marks the intent **failed**; the same key may be retried.
- A receipt exists only for an applied intent. There is no receipt-first path.
- Each handler declares how its effect commits, and that decides what a retry
  of a still-pending intent (a crash between effect and receipt) does:

  | kind      | effect commits                                   | retry of a pending intent        |
  |-----------|--------------------------------------------------|----------------------------------|
  | control   | in the same control.db transaction as the receipt | cannot happen                    |
  | workspace | in one workspace.db transaction with a `command_effects` marker holding the handler result | reuses the marker; handler does not re-run |
  | self      | handler-owned, idempotent on the command id (dispatch: `execution_key`) | re-runs the handler              |
  | external  | outside any transaction (async)                  | fails `OUTCOME_UNKNOWN`          |

  Re-running a handler is never the default: state transitions and version
  bumps are not idempotent, so atomicity with a marker or receipt — not
  deterministic ids — is what makes recovery safe.
- An unknown external outcome needs reconciliation, never a blind retry.
- Clients reuse the command id on retry; the request digest covers the whole
  envelope. Routes that adapt a non-envelope body (the human approval
  decision) derive the command id from the actor and idempotency key, so a
  retry finds its own intent.
- The handler declares the receipt outcome: `applied` (200) when the effect is
  complete, `queued` (202) only when it started asynchronous work.

## Consequences

- Do not reintroduce "commit the receipt first, apply later" to shorten the
  control transaction; the shortness is now bought by running workspace
  handlers in their own workspace transaction, not by deferring the effect.
- A crash between effect and receipt leaves a pending intent; only a client
  retry resumes it. There is no background sweeper.
- Most workspace commands now answer 200/`applied` instead of 202/`queued`.
- Every workspace database carries a `command_effects` table owned by the
  funnel.
