# 04 — Persistence, transactions and recovery

## Database access rules

Use Drizzle with a pinned better-sqlite3 driver for Brain-owned tables. Synchronous database operations must be short and indexed; no `await` inside a better-sqlite3 transaction callback. Better Auth uses its documented adapter and generated current schema in `control.db`. Mastra uses its private libSQL file. TencentDB manages its own files. Initialize the current format on fresh state and validate it on reopen; do not write historical converters, backfills or vendor-table repair code.

One active Governor owns domain writes. Open bounded read connections only when measurement warrants them. Start with a workspace-store LRU of 16 inactive handles; do not evict an active transaction or pinned workflow engine. Mastra instances/snapshot handles have a separate limit and eviction gate that proves reload. An idle suspended workflow must be reloadable from disk; it must not require one resident JS graph forever.

Baseline PRAGMAs for each Brain connection: `foreign_keys=ON`, WAL, `synchronous=FULL` for control authority, `busy_timeout=100` ms, bounded cache and WAL checkpoint policy. Workspace durability defaults to FULL too; NORMAL requires an explicit documented loss budget. A short busy timeout avoids blocking the Node event loop for seconds. Retry SQLITE_BUSY with jitter outside the transaction, bounded by the request deadline; preserve the same idempotency key. BEGIN IMMEDIATE is used for claim/permit transactions. SQLite has no SELECT FOR UPDATE row-lock substitute.

Use local supported SSD filesystems. Never run active-active on a shared file or copy only a live `.db` file as backup. Monitor WAL size and long readers. Checkpoint during measured low load, not after every write. A persistent WAL above 128 MiB triggers diagnosis; do not force truncation while readers are active. Inspect driver engine version/compile options at startup and in doctor.

## Global authority transactions

| Transaction | Must commit together |
|---|---|
| Command accept | Request hash/idempotency row, durable intent, receipt, audit, outbox |
| Offer claim | Job queued/version check, runner session/epoch check, reservations, attempt, offer expiry, outbox |
| ACK | Current offer/runner/epoch/lease check, attempt state, execution expiry, outbox |
| Effect permit | Current authorization/revocation, exact approval consumption, resource leases/counters, effect intent, grant, audit/outbox |
| Completion accept | Current attempt/fence, terminal candidate receipt, reservation update, verifier work intent, audit/outbox |
| Revoke/quarantine | Revocation generation, pending permit invalidation, stop commands, affected attempts marked suspect, audit/outbox |

All are one database file and short CPU/SQL work only. Hashes/preflight metadata can be prepared before the transaction, but every mutable condition is revalidated inside it. Never hold a transaction while probing a target, uploading artifacts, running an LLM or asking a human.

Policy, membership and revocation facts used for effects must come from authoritative current records, not delayed workspace projections. Config digest remains pinned for reproducibility; current emergency restrictions can only narrow it. Job output/evidence validation may finish later; a committed completion candidate does not mean final success.

## Workspace transactions

Workspace command application updates cards/workflow business state, increments aggregate version, inserts inbox receipt and workspace outbox in one local transaction. It never writes global job status as authority. A task's Done transition checks a verified evidence record and source authority watermark; if global acceptance is pending, show Verifying.

Reference SQL includes foundational tables and constraints for the target. Better Auth tables are generated from the pinned plugin configuration; required pack tables belong in the current schema definition. Track current schema identity and initialization status, not a historical upgrade chain. An existing unsupported database is rejected/preserved rather than automatically converted or reset. No reference SQL file is represented as a complete production database.

## Durable cross-file coordination

Use a transactional outbox in the source DB and an inbox in every destination. The event ID and payload hash are immutable. Each delivery destination has its own acknowledgment; a single delivered boolean cannot represent fan-out. Workers claim batches with recoverable processing leases, write destination inbox plus mutation in one destination transaction, then acknowledge source delivery. Crash between destination commit and source acknowledgment causes redelivery, safely deduplicated.

For ordering, carry aggregate sequence and source feed cursor. An inbox row deduplicates by source/event ID; receiving the same ID with a different hash quarantines the delivery. An event affecting multiple workspace files creates independent deliveries. Never open 100 workspace files in one global transaction.

Global dispatch acceptance emits `dispatch.requested`; workspace consumer creates the workflow run/start intent and emits `workflow.start.requested`; the workflow bridge calls Mastra. Each stage has a deterministic idempotency key. If workspace storage is down after global acceptance, receipt remains queued and an operator can see delivery lag. Cancellation during that lag is retained as a tombstone/intent, so a delayed create cannot resurrect work.

Outbox processing defaults: 100 events or 10 ms CPU per turn, per-workspace fairness, exponential backoff capped at 60 seconds for transient IO, dead-letter after a configured horizon with a visible repair action. Authorization failure is not a transient retry. Keep referenced events until all required consumers acknowledge; archive rather than erase audit data.

## State and monotonic versions

State machines are explicit in `contracts/v1/state-machines.json`. Runner operational axes are independent. Jobs aggregate attempts; attempts never transition from failed/succeeded/cancelled back to running. A retry is a new attempt number. Approval decision is immutable; revocation is a later event. A consumed one-shot approval cannot be reset after a timeout.

Out-of-order terminal reports cannot overwrite a newer attempt. Terminal candidates after lease loss can be stored in a quarantined late-evidence channel for investigation, but cannot change authoritative status. Duplicate terminal report/same digest returns original acknowledgment; different digest returns conflict. Receipt acceptance before lease expiry can release compute reservations while independent verification continues under its own lease.

## Crash recovery matrix

| Crash boundary | Recovery |
|---|---|
| Before source transaction commit | No durable effect; same request key can retry |
| After commit before HTTP response | Return saved receipt on retry |
| After outbox send before ACK | Redeliver; destination inbox deduplicates |
| After offer before runner ACK | Expire offer and release reserved capacity; no approval consumed |
| After ACK before local process spawn | Read-only retry after lease expiration; effect ledger determines write safety |
| After approval consumed before tool starts | Reconcile permit/target; approval remains consumed; issue fresh exact approval if execution cannot safely reuse its single invocation |
| During target mutation | Mark outcome unknown; target-specific readback; keep conflict guard until outcome settled |
| After target success before receipt | Recover receipt/readback through immutable invocation ID; never blindly repeat |
| After receipt accepted before workspace projection | Global result remains authoritative; outbox repairs workspace |
| After wake accepted before snapshot visible | Durable wake stays pending until exact wait appears |
| During fresh initialization | Do not publish a partially initialized database; retry owned disposable initialization safely and preserve existing non-disposable state |
| Disk full/corruption | Refuse new authority mutations and permits; emit independent health signal, preserve files, operator repair |

Governor restart increments a boot generation and reconstructs leases from durable timestamps. Do not simply expire all attempts and relaunch. Runners reconnect with their existing attempt identity; lease validity and grant revocation are checked. Clock anomalies stop new effect permits until time health is restored. Runner local deadlines use monotonic elapsed time derived conservatively from the server's duration, not trust in wall-clock agreement.

## Backup and import

Global disaster recovery and workspace portability are different operations. Global backup preserves identity/auth, job/approval/effect ledger and all referenced workspace bundles at a consistency cut. Workspace export preserves scoped business history/config/artifacts/memory but excludes reusable global approval grants, machine tokens, user password records and old leases.

A consistent export first blocks new workspace writes/dispatches, quiesces owned work or records in-flight unknowns, drains projections to watermarks, snapshots Brain DBs through the online backup API, captures Mastra snapshots at its verified boundary and closes over referenced CAS bytes. Record config/adapter digests and TencentDB export support. A set of individually valid SQLite snapshots is not automatically a consistent cross-file snapshot.

Restore into a temporary directory, verify manifest/hash/path constraints, check schema/adapter support, remap workspace IDs on portable import, invalidate all old tokens and leases, create restore audit record and leave workspace suspended. Old production approvals never become executable in a restored timeline. In-flight effects remain unknown until target reconciliation. Switch the registry pointer atomically only after validation. Incomplete memory export produces `completeness: partial` and names missing components.
