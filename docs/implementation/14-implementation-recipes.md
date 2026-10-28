# 14 — Implementation recipes and integration probes

The following algorithms specify Brain behavior. They are pseudocode, not claims about vendor APIs. Translate them into the named modules and verify with the acceptance scenarios. No network/LLM/human wait belongs inside an SQLite transaction.

## Atomic command acceptance

```text
authenticate -> internal actor
decode strict command and validate bounded JSON
resolve current organization/workspace membership
compute canonical request hash
BEGIN IMMEDIATE control.db
  find key by (organization, actor, commandType, idempotencyKey)
  if found and hash differs: rollback with IDEMPOTENCY_CONFLICT
  if found and hash same: return stored receipt after transaction ends
  authorize command using current authoritative facts
  allocate command/resource IDs
  insert command intent and immutable initial receipt
  insert audit event and required outbox deliveries
  insert idempotency record
COMMIT
return 202 receipt
```

Workspace commands are applied by a durable consumer; response can be polled by command/resource ID. Do not wait for a workspace commit while a global transaction stays open. Idempotency records retain the initial acceptance receipt; a separate query returns current command/resource outcome.

## Atomic claim with rollback

```text
prepare eligible candidate IDs from bounded in-memory/indexed query
BEGIN IMMEDIATE control.db
  authenticate runner identity/session epoch and current admission state
  select one candidate still queued and not past deadline
  recheck membership/group/policy/approval admission/budget and verified capabilities
  UPDATE runner SET reserved += demand
    WHERE capacity-reserve-reserved >= demand on every resource
  require exactly one changed row, otherwise rollback candidate
  UPDATE job SET state=offered, attempt_counter+=1, job_fence+=1, version+=1
    WHERE id=? AND state=queued AND version=expected
  require exactly one changed row
  insert attempt with current epoch, new lease ID, ACK deadline and job fence
  insert capacity reservation and offer event/deliveries
COMMIT
return offer
```

Do not let a failed candidate leave reserved resources behind. Candidate selection is advisory; the transaction revalidates. For no eligible job commit no mutation and long-poll at the transport layer. Request IDs make retries of a lost claim response return the already-issued offer for that runner instead of reserving another slot.

## Exact effect permit with sorted lock acquisition

```text
read-only target probe -> observed target precondition
validate invocation shape, release and canonical subject digest
BEGIN IMMEDIATE control.db
  lookup prior invocation; same request -> prior permit, changed request -> conflict
  check attempt running, runner epoch, job fence, live lease, workspace active
  check current actor delegation, membership, revocation and restrictive policy
  check approved subject digest, expiry, reviewer policy and unused approval
  for resourceKey in sorted unique canonical keys:
    reject live lease OR unresolved-effect guard
    increment persistent resource fence (reject overflow)
    create lease/guard for this invocation
  consume one-shot approval for exactly this invocation
  insert issued permit, effect intent, audit and outbox
COMMIT
return short-lived audience-bound permit
```

The broker performs online validity check and target precondition enforcement immediately before the effect. If a target has no atomic precondition, document the remaining race and block unacceptably risky operations. Broker cannot claim a multi-resource external operation is atomic: it records per-target effects and uses explicit compensation only where a reviewed tool supports it.

## Completion and independent verification

Verify uploaded artifact associations/hashes before accepting candidate completion. In a short global transaction validate current attempt/epoch/fence/receipt hash, save terminal candidate and create evaluator work intent. Release compute only after cleanup confirmation; retain unresolved effect guards independently. A separate evaluator checks immutable evidence and target receipts. Its accepted verdict finalizes job state globally and projects the workspace card. If a late stale receipt is useful, store it as quarantined evidence without finalization authority.

## Durable wake bridge

Creating a gate first commits an approval request plus a correlation/wait intent. The engine then persists its suspended state. A decision writes the human record and wake event in one global transaction. Wake worker waits until `inspect` confirms matching run/wait generation. It calls resume with event ID, records ACK, and can repeat safely after a crash. If the engine is already past the wait, verify the step's durable execution key/output before acknowledging; do not assume absence of suspended state means success.

Dispatch steps use the same pattern: step execution key creates one job, then returns or suspends. Job completion wake repeats safely. The state bridge must handle engine success plus missing business evidence by leaving the product run Verifying/Blocked, not copying the upstream success status.

## Mastra G03 probe

Create `tests/probes/mastra/` in T29 with the exact package lock and a temporary private file store. Register only six fixture wrappers and a graph compiled from the canonical example. Prove each wrapper is representable through the documented dynamic graph API. Test a gate whose decision arrives before snapshot, 100 persistent waits, kill/restart, duplicate start/wake, disabled primitive, version replacement, runtime cancellation and failed snapshot write. Capture schemas/API signatures, database engine version, errors and event IDs.

Pass requires no duplicate application execution key, no runner reservation during waits, all expected waits restored and deterministic source-to-IR digests. A fast in-memory success does not pass. Use a temporary local path and close handles before deletion; never attach the product workspace DB for the probe. Shared-file Brain/libSQL testing is optional later optimization, not a prerequisite for the chosen separate-file profile.

## TencentDB G04 probe

Pin the full source/image revision, inspect its official deployment/HTTP schemas, enable private authenticated bind and check health/FTS5. Create org A workspace A1/A2 and org B workspace B1 with separate user/agent/team mappings. Insert uniquely identifiable canaries in chat/skill/wiki/codegraph. Test read/search/direct-ID paths with missing/wrong scope, forged header/body identities, revoked membership and cached queries. Gateway auth and upstream service isolation are separate assertions.

Export only A1, restore into a clean temporary instance and compare canary digests, provenance, ACL and deletion behavior. Test asynchronous indexing/partial failures and private Git URL support only with disposable credentials. Measure idle RSS, indexing peak and disk usage. If scoped export or isolation fails, record exact unsupported assets; disable that feature or use physical isolation. No “successful search” substitutes for cross-tenant negative coverage.

## Harness G05/G06 probe

Use one deterministic task: read a fixture repository, produce a typed report, propose a forbidden target effect and attempt a denied filesystem/network operation. Run under both Pi and Claude with controlled home/resources and fixed provider/model configuration. Confirm normalized start/text/tool/result/usage/end, cancellation, checkpoint, malformed event handling and absence of host secret/socket access. Test nested child escape and TERM-ignoring process. Report unsupported steer/resume/fork rather than inventing parity.

Keep provider cost/network tests separate from fixture-based deterministic CI; real-provider contract tests have explicit credentials, budget and retention. Disabling a provider does not bypass the shared sandbox policy.

## Worked support workflow

1. Human dispatches support investigation using the same command from web/CLI/MCP; Governor records command intent and workspace projection creates the pinned run.
2. `investigate` schedules on an agent group with read-only ticket/repository tools. It creates a draft artifact, evidence references and an exact publication proposal.
3. `verify` runs on an evaluator group using the draft digest and immutable rubric. Failed/insufficient evidence blocks downstream publication.
4. `approve` commits an exact approval request and suspends. Agent/evaluator slots and locks have been released. The draft remains an immutable artifact.
5. Human reads exact text/target/evidence, authenticates and approves its digest. Early/replayed decisions create at most one decision/wake.
6. `publish` is offered to a privileged tool group. It re-probes ticket state, requests an exact effect permit, consumes approval, posts using target idempotency/precondition where supported, and stores a remote receipt.
7. `final-check` independently reads back the published comment. Only verified matching text/target and durable evidence finalize success/Done.
8. If runner dies after posting, the job becomes outcome unknown. Reconciler finds the invocation/comment receipt and either proves application, proves absence for safe authorized retry, finds conflicting state or leaves it blocked. It never blindly reposts.

The example references synthetic placeholder release digests and does not pretend those agents/tools/evaluators are already published. T10 verifies release closure before activation; fixture tests bind placeholders to fixture registry entries.
