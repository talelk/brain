# 02 — Transport, commands and event delivery

## Contract authority and encoding

`contracts/v1/brain.schema.json` is the wire-shape authority. Generated DTOs use JSON values only: no Date, Map, bigint, functions, undefined values or vendor SDK types. UTC timestamps on the wire use RFC 3339; SQLite stores integer epoch milliseconds. CPU uses integer millicores; memory/disk use MiB even where legacy field names say `memoryMb`/`diskMb`. Currency budgets use integer micro-USD, never binary floating point.

Identifiers are opaque, bounded ASCII strings. Logical configuration IDs use lower-case kebab/dot syntax; workspace database paths are resolved from opaque IDs. Digest is exactly `sha256:` plus 64 lower-case hex characters. Fencing and sequence counters are safe positive integers with explicit exhaustion checks; reaching the supported bound stops allocation with a diagnostic. No counter-format migration is part of this implementation. Source Git revisions include algorithm plus full object ID; do not assume all Git repositories use SHA-1.

Canonical hashing uses RFC 8785-compatible canonical JSON over validated JSON values; nonfinite numbers and duplicate JSON keys fail. Digests have a domain-separated prefix and schema version, e.g. `brain:approval:v1\n` plus canonical payload bytes. Byte hashes for CAS are over raw bytes; JSON object hashes are over canonical bytes. The dependency gate must select a reviewed canonicalizer and cross-check published RFC test vectors; do not pretend Python `sort_keys` is a general RFC 8785 implementation.

## HTTP surface

The machine-readable [OpenAPI](../../contracts/v1/openapi.json) describes the shared endpoints. Prefix application routes with `/v1`, runner routes with `/runner/v1`, auth routes with `/api/auth`; MCP uses `/mcp` Streamable HTTP. Browser and runner credentials are distinct. TV identities are read-only and cannot obtain human command scopes.

| Route | Meaning | Durable response |
|---|---|---|
| `POST /v1/commands` | Typed application mutation | Command receipt, `200` applied or `202` accepted |
| `POST /v1/query` | Typed authorized read | Snapshot/page and projection cursor |
| `GET /v1/events` | Authorized SSE with cursor | Durable event references; lossy text deltas may be marked volatile |
| `POST /v1/approvals/{id}/decision` | Human-only decision | Recorded decision and updated approval version |
| `POST /runner/v1/enroll` | Consume administrator-issued enrollment token | Bound runner identity credential |
| `POST /runner/v1/hello` | Verify identity and create/recover session epoch | Session, server time, negotiated contract |
| `POST /runner/v1/heartbeat` | Session inventory and liveness | Accepted sequence and commands |
| `POST /runner/v1/claim` | Reserve an eligible offer | `200` offer or `204` no eligible work |
| `POST /runner/v1/attempts/{id}/ack` | Accept offer before expiry | Execution lease snapshot |
| `POST /runner/v1/attempts/{id}/renew` | Renew current attempt lease | New server expiry |
| `POST /runner/v1/attempts/{id}/events` | Durable ordered batch | Last committed sequence |
| `POST /runner/v1/attempts/{id}/permit` | Authorize one exact tool effect | Short-lived effect permit |
| `POST /runner/v1/attempts/{id}/complete` | Submit terminal receipt | Accepted for verification or stale rejection |
| `POST /runner/v1/attempts/{id}/release` | Acknowledge stop and cleanup | Owned reservations released or reconciliation required |
| `POST /v1/artifacts/init` | Reserve upload of expected digest/size | Scoped upload ID |
| `PUT /v1/artifacts/{id}/content` | Stream bytes with bounds | Verified stored reference |
| `GET /v1/artifacts/{id}/content` | Download authorized bytes/range | Attachment with safe content type |

Every request has a correlation ID. Error body contains stable `code`, human-readable `detail`, `retryable`, correlation ID and optional field errors/retry delay. A 404 is returned for inaccessible object IDs to avoid existence leaks; a known action denied on an accessible object returns 403. 409 covers stale aggregate version, idempotency hash conflict or state conflict; 410 covers expired replay cursor; 413 size limit; 422 valid JSON failing contract/semantic rules; 429 bounded admission; 503 unavailable authority. Errors never include credentials, raw SQL or model prompts.

## Command catalog and authorization

The registry enumerates command types, scope, authority database and actor classes. Minimum commands include workflow dispatch/cancel, session steer/stop, approval request/decision/revoke, runner drain/quarantine, board create/move/comment, decision record, config activate, workspace suspend/export/import, tool propose/publish, memory search/publication/revoke and placement explanation as a query.

Human approval decision is a separate endpoint plus application handler. It is deliberately absent from the agent-facing MCP mutation catalog. An agent cannot acquire it by supplying a human actor object or a broad workspace scope. CLI routes a decision through human login and explicit terminal confirmation; an unattended agent process receives a review URL only.

Query catalog: `today`, `bridge`, `workspace.context`, `jobs.list`, `job.get`, `job.explain`, `runners.list`, `runner.get`, `approvals.list`, `approval.get`, `sessions.list`, `session.get`, `board.get`, `evidence.get`, `memory.search`, `sla.summary`, `config.explain`, `platform.health`. Query filtering, sorting and pagination are typed allowlists; no SQL or arbitrary JSONPath arguments.

After authentication, `workspace.context` returns the resolved safe presentation defaults in `WorkspaceContext.ui`, alongside the existing allowed commands and feature availability. This is the same `UIConfig` contract declared in Git; it contains no credentials or authority grants. A client enables a requested channel only when the server's built feature registry also supports it. Before authentication the static shell uses its bundled safe theme/locale defaults; no anonymous config download or new privileged configuration endpoint is introduced.

## Idempotency rules

Namespace keys by `(organizationId, actorId, commandType, idempotencyKey)`. The server hashes the validated command including workspace, payload and expected version. Same key/same hash returns the saved receipt; same key/different hash returns `IDEMPOTENCY_CONFLICT`. Different caller identities cannot discover each other's receipts. A command that affects a workspace crosses databases using a durable command intent; initial receipt is stored globally and workspace processing deduplicates by command ID.

Idempotency records for external effects outlive the maximum retry/reconciliation horizon and remain referenced by the effect ledger. A request timeout is not a proof that no mutation occurred: clients query/retry the same key. Repeated requests never allocate a new dispatch or charge a second approval consumption.

Optimistic board/comment updates carry `expectedVersion`. Compare-and-swap failure returns current version and a refresh link. No last-writer-wins overwrite of decisions or approval text. Deleting a card does not delete its audit/evidence.

## Events, replay and ordering

Each authoritative DB emits events with a local monotonically increasing feed cursor; each aggregate has a separate consecutive sequence. These numbers are not globally comparable across workspace files. The event envelope includes event ID, schema version, tenant/workspace, aggregate, causation/correlation, actor reference and pinned configuration where applicable. UI cursor is an opaque signed structure bound to feed identity, filters and organization; never concatenate unrelated SQLite sequences.

Outbox/inbox delivery is at least once. Consumers deduplicate event ID and validate per-aggregate ordering. A sequence gap parks the event and requests/replays missing state; it must not guess. Same sequence and different payload hash is a protocol/security fault. Unknown major event versions are parked and alerted; unknown optional fields within the negotiated version are retained only where explicitly allowed.

SSE starts with an authorized snapshot watermark, replays after that cursor, then follows the live feed. The snapshot and cursor must share a consistent read transaction. Reconnect uses `Last-Event-ID`. Expired retention returns a reset-required message and a new snapshot path. Default retention proposal: seven days for UI replay, thirty days for operational event detail; audit/evidence retention is independent.

Authorize stream subscriptions at connect and on membership/revocation changes. Bound each subscriber queue to 1 MiB/1,000 events; close slow consumers with reset instructions. Send a keepalive every 15 seconds and disable proxy buffering. Rendering a text stream must not re-render the whole application per token; coalesce display updates every 50–100 ms. Durable tool/effect/approval events are never discarded as volatile.

## Ingress limits and client behavior

Default JSON body limit 256 KiB, runner batch limit 128 events/256 KiB, tool input 64 KiB, single event payload 32 KiB. Larger context/results are artifact references. Nesting depth 32 and query page size at most 100. Artifact upload defaults to 100 MiB with per-workspace quotas; authorized larger build artifacts use a separate profile. Check declared and actual bytes; gzip bombs must meet decompressed limits too.

CLI prints machine JSON with `--json`, progress to stderr, no color when noninteractive and nonzero exit codes for denied/failed/unknown. Ctrl-C cancels local observation; remote job cancellation requires an explicit command so a broken terminal does not accidentally kill work. MCP tools return typed receipts and review links; protocol cancellation cancels only the RPC unless the tool explicitly represents job cancellation.

## Versioning

Use one current target contract set. Version tags identify payloads and current-build runner handshake validation rejects unsupported versions before claims. Strict validators do not accept arbitrary added fields. Target wire shapes may change together with generated DTOs, callers, fixtures and tests; no parallel V1/V2 handlers, compatibility normalization or rolling-upgrade support is required until the user explicitly requests it. Persist current contract/adapter references for audit and same-version recovery.
