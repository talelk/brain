# 10 — Performance budgets, deployment and operations

## Workload contract

These are proposed acceptance targets, not measured results. Initial control-host reference is 2 dedicated vCPU, 4 GiB RAM, local SSD, Linux/cgroups v2, one active Governor; memory services have a separate measured allocation and runners are excluded. Initial dataset: 25 workspaces, 50 registered runners, 100,000 jobs/history rows, 1,000 pending approvals, 100 suspended workflows, 200 live observers and 20 incoming commands/second with short bursts to 50. Ten concurrently executing agent jobs live on runners, not the control host. Repeat measurements at 10× history with the same working set.

| Measure | Proposed target under declared workload |
|---|---|
| Authorized local query | p95 ≤150 ms, p99 ≤400 ms excluding network |
| Command durable acceptance | p95 ≤200 ms, p99 ≤500 ms; queued downstream work excluded |
| Ready job placement after capacity event | p95 ≤1 second, p99 ≤3 seconds |
| Authority write transaction | p95 ≤10 ms, p99 ≤25 ms; measure fsync separately |
| Node event-loop delay | p99 ≤50 ms; alert sustained >100 ms |
| Durable event visible in UI | p95 ≤1 second on healthy local network |
| Outbox lag | p95 <2 seconds; alert >30 seconds for required consumer |
| Governor idle/steady RSS | target <512 MiB / <1 GiB excluding memory services |
| Mobile initial route JS | ≤250 KiB gzip for shell+Today; charts/diffs lazy-loaded |
| Interaction responsiveness | INP target ≤200 ms; long transcript does not block input |
| Suspended workflow idle CPU | No per-run busy polling; global bounded wake worker |
| House progress under load | One ready small house task starts within 30 seconds when reserved capacity exists |

If fsync/storage or upstream engine behavior makes these unattainable, publish measured limits and lower admission before scaling. SQLite serializes writes; high throughput comes from short batched transactions and bounded work, not imagined parallel writers.

## Hot path design

Precompile validators per immutable schema digest; never compile untrusted schemas per request. Cache effective config/IR by digest in a bounded LRU. Membership/revocation decisions use short-lived/versioned authoritative caches and bypass stale caches for effects. Prepared SQL indexes cover ready jobs, pending approvals, lease expiry, source outbox cursor, workflow state and tenant-scoped lookups. Run EXPLAIN QUERY PLAN on realistic data; avoid broad JSON scans on scheduling paths.

Keep high-volume text out of SQLite: append bounded compressed redacted segments to CAS/spool, store indexes and summaries. Batch usage/telemetry updates every 250–1,000 ms with bounded loss policy; never batch away approval/effect audit durability. Use Pino asynchronous transports away from hot paths, with controlled backpressure. Do not use telemetry sink availability as authorization authority.

CPU-heavy hashing of large artifacts, archive processing, schema compilation and CodeGraph work run in worker/child tasks with quotas. Stream artifacts and enforce bytes; no full-file base64 over JSON. Use keyset pagination; stable order includes unique ID. Do not count every table synchronously for every dashboard refresh; use idempotent aggregates and visible watermark.

Server sends snapshot plus incremental events. Browser keeps normalized bounded stores, virtualizes long tables/timelines, coalesces text updates and loads chart/diff modules on demand. Background tabs reduce rendering. Abort superseded queries; do not let an older search response overwrite newer filters. Reconnect does not refetch every route at once.

Use NewUI's `DataTable` and `VirtualList` organisms before adding direct TanStack rendering code. Keep `@talelk/newui-charts` route-lazy and omit editor/code-editor packages until a measured feature needs them. Verify published source/CSS consumption with Vite/Solid: missing scanned recipes, all-package imports or inherited playground/devtools code must not inflate the initial route or leave controls unstyled. The existing bundle budget applies to the actual NewUI-backed production app; a library documentation demo is not a Brain performance benchmark.

## Benchmark protocol

Fix seed/data, hardware, OS, Node/packages, embedded SQLite versions, image digest, source revision, PRAGMAs and filesystem. Record cold startup and warm steady-state separately. Run at least three comparable 10-minute steady-state trials and report median/p95/p99, errors, throughput, CPU, RSS, event-loop delay, disk IO, WAL growth and queue age. Do not mix cold builds, live model latency and scheduler latency in one metric.

Fault profiles: slow fsync, 100 ms network jitter, dropped runner connection, slow SSE consumer, TencentDB down, busy workspace file, 100 simultaneous approval wakes and 10 MiB/sec transcript traffic. Apply rate limits/backpressure; control health/permit denial remains responsive. Tests include a workload above capacity to verify bounded queues and honest 429/queued status, not just a successful happy path.

## Compose profiles and startup

Core: Governor serves static web, Hono/auth/MCP/SSE and timers; one instance, nonroot, read-only root filesystem, constrained tmpfs, state volume and read-only release volume. TLS reverse proxy/VPN is a deployment prerequisite for remote access. Optional memory-core/knowledge, observability and notification profiles use exact images/digests after gates. No default externally reachable memory/admin ports.

Runner Compose is a separate project/host, supervisor plus constrained launcher and job storage. Agent and privileged groups have separate trust domains. No central DB volume, inbound SSH dependency or raw Docker socket in jobs. Compose examples are topology skeletons until images/secrets/health commands are implemented and rendered with `docker compose config`.

Startup order: validate environment/secrets/filesystem ownership → acquire exclusive Governor process lock → verify DB engines and space → initialize fresh current schema or validate the existing current format → recover inbox/outbox/leases → load config registry → probe adapters → start API readiness → enable scheduler for supported healthy features. Liveness only proves process responsiveness; readiness depends on authority DB/current-schema validity. Unsupported formats are preserved and rejected, not converted or reset. Memory failure marks its feature degraded, not global liveness failure.

Graceful shutdown: stop new claims/permits, persist stop generation, flush audit/outbox buffers, signal runners where needed, let short transactions finish, close SSE with reconnect, checkpoint/close own DB handles and exit before orchestrator timeout. A Governor shutdown does not blindly cancel all remote reads; leases define authority. Privileged tools cannot obtain new permits while authority is unavailable.

## Runbooks

| Symptom | Immediate safe action | Diagnosis / recovery |
|---|---|---|
| Control disk full | Stop dispatch and effect permits | Preserve WAL, free non-authoritative cache, increase storage, integrity check from copy |
| Corrupt DB | Remove readiness; preserve originals | Restore verified backup in isolated directory; reconcile external effects before activation |
| Lost runner | Wait lease safety boundary, mark suspect | Launcher/credential revocation and target readback; no blind mutation retry |
| Unknown external effect | Keep conflict guard, disable Retry | Connector reconcile returns present/absent/conflicting/unknown with evidence |
| Memory outage | Show retrieval/indexing degraded | Circuit-break bounded queries; backlog publications; no approval impact |
| WAL growth | Find long reader/failed checkpoint | End owned stale reads, measure checkpoint; do not delete live WAL |
| Backlogged outbox | Show lag and consumer health | Retry bounded; park poison event; repair version mismatch, replay idempotently |
| Quarantined runner | Revoke identity/target credentials | Preserve diagnostics; reimage/re-enroll after explicit review |
| Expired approval | Preserve draft, disable execution | Re-probe exact target and create fresh request |
| Compromised signing secret | Emergency stop grants | Rotate key/version, invalidate sessions/permits, audit exposure, reconcile attempts |

## Recovery objectives and retention

Proposed starting objectives: encrypted off-host backup every hour (RPO ≤1 hour for a total host loss), daily restore rehearsal in staging and RTO ≤2 hours for the reference dataset. Transaction durability protects acknowledged writes on surviving storage, but hourly backups do not imply zero data loss after host loss. Memory recovery may be partial until G04/G07. Keep 24 hourly plus 14 daily verified backups as a starting policy; data-classification/legal requirements may override.

Test key recovery and backup encryption, not only file creation. Backup manifests include watermarks, all required CAS bytes, pinned releases, engine snapshots and memory completeness. Isolate restored runners from production until approval/lease invalidation is verified. Retention and deletion propagate separately through transcripts, CAS, DB history, memory and off-host backups.

### Implemented local maintenance path

The current implementation provides a **partial local archive**, not a complete disaster-recovery or portable-workspace export. Run these commands on the Governor host, using absolute paths with existing parent directories:

```sh
pnpm --filter @brain/governor maintenance backup /srv/brain/data /srv/backups/brain-20261027
pnpm --filter @brain/governor maintenance verify /srv/backups/brain-20261027
pnpm --filter @brain/governor maintenance restore /srv/backups/brain-20261027 /srv/brain/restored
```

Stop the source Governor and any other writers first. Governor and maintenance acquire the same kernel-held SQLite ownership lock; a live Governor causes backup to fail with `CONFLICT`. A crash releases ownership automatically. Maintenance never stops a running process. Output directories must be absent or empty, have existing real parent directories, and be separate from the source. Verification reads every archived file; it does not accept a manifest alone as proof.

Database files use the selected driver's SQLite backup API, which includes committed WAL pages. WAL/SHM files and process ownership files are excluded. Hashing and file copies use a bounded 1 MiB buffer. File/manifest hashes, SQLite integrity and foreign keys are checked. Unsafe relative paths, duplicates, links and special files are refused. Files are created privately in a sibling staging directory, synced, and published by rename only after success. Partial staging output is removed on failure; existing nonempty destinations are preserved.

The archive's internal `brain.local-backup/v1` framing lists paths, bytes, hashes and missing components. It is deliberately distinct from the product `brain.backup/v1` `BackupManifest`. Its completeness is always `partial`: authorized TencentDB memory/Wiki/CodeGraph exports, Mastra export verification, adapter inventory and consistent authority watermarks are still required. These commands do not claim the encrypted off-host backup, RPO/RTO, online consistency-cut or full G07 acceptance targets above.

`authority.keys` persists session/cursor key material with owner-only permissions. It is secret operational data included in private local archives; protect the entire archive accordingly. No keys belong in Git. A normal restart retains sessions; restoring an archive revokes them.

Each restore writes a fresh restore identity. On first open, one control-database transaction revokes old Brain/Better Auth sessions, runner credentials, enrollment/challenge tokens, delegated grants, step-up evidence, approvals and unused permits; quarantines runners; suspends workspace execution; blocks queued jobs; marks active attempts as outcome unknown; and parks pending deliveries/wakes. Resource conflict guards remain until reconciliation. The same transaction records an inbox receipt keyed by restore identity. A crash or missing filesystem acknowledgement cannot repeat half the revocation, and a later restore receives a new identity. Restored workspaces remain `restore_pending`; controlled reconciliation/reactivation and complete component recovery are unfinished. Do not reset production data to bypass this state.

The remote Brain CLI does not open databases or choose arbitrary server filesystem paths. Maintenance stays inside the Governor executable and its operations module. Regression evidence lives in `tests/chaos/backup.test.ts`, `restore.test.ts` and `recovery.test.ts`; full platform status and outstanding implementation work are in `23-runtime-status.md`.

## Performance within the modular monolith

Keep one Governor process and in-process module calls. Use indexed keyset queries, bounded claim scans, short SQLite transactions, bounded upload/event buffers, coalesced live rendering and explicit worker admission. One authenticated SSE connection per browser scope feeds bounded route views. Process-local caches are disposable derived data keyed by authorization generation. Use one shared run-detail composition rather than refetching the same job into several page stores. Add queue services, distributed caches or native rewrites only for a measured bottleneck; they are not requirements of this target.
