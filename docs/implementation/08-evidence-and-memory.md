# 08 — Evidence, knowledge, connectors and improvement

Current implementation and its remaining limits are recorded in [25 Evaluator authority](25-evaluator-authority.md). The contracts below remain the full target; local fixture evaluation does not certify every item.

## Evidence completion gate

An EvidenceBundle binds organization/workspace, workflow/job/attempt, job fence, source/config/workflow/primitive/tool releases, acceptance criteria, artifacts, external receipts, approval references and timestamps. Artifact entries include digest, bytes, media type and classification. Each acceptance criterion names a deterministic check or an explicitly approved human assessment, its expected oracle and observed result.

Authoring output is a submission, never a verdict. Governor schedules an evaluator attempt with the exact submitted digest, read-only input artifacts, pinned evaluator code and its own lease. Evaluator cannot modify submitted artifacts or accepted test fixtures. Verify hashes before evaluation and again before acceptance. Authoring agent cannot call `evidence.accept`.

Independence levels: L1 separate process/attempt with immutable tests; L2 separate runner trust domain for release/production checks; L3 independent human or external verification where policy requires. “Another prompt in the same compromised runner” is not L2. Record evaluator identity/release, environment, input digest, results and missing checks. Use deterministic evaluators by default: schema checks, fixed tests, artifact hashes and target readback. Independence is an execution/trust property and does not require another model call. Reuse the scenario corpus and evidence format across CLI, browser and probe drivers. An LLM judge is a supplemental scored signal with rubric/model/calibration; it cannot establish test success or authorize an effect.

Bundle state is assembling → submitted → verified/rejected/incomplete. Submitted bundles are immutable. Corrections produce a new bundle referencing the prior digest. Job success and Board Done require all required criteria accepted, artifacts durable, external effects reconciled and authoritative verdict accepted. Partial work lists unmet criteria and cannot satisfy a required success dependency unless the workflow explicitly has a reviewed partial-result schema.

Evidence may outlive logs. Store raw transcripts briefly by classification, validated evidence longer, approval/audit under organization retention policy. CAS garbage collection marks from live releases, pending/unknown effects, evidence, backups and export manifests; only unreferenced data older than the grace period is deleted. Default grace seven days, interrupted uploads 24 hours; GC is audited and cannot race an active upload/publication reference.

## TencentDB integration boundary

Use a Governor-owned MemoryGateway; runners and browsers never receive the service's broad key. Map verified organization/workspace/user/agent to service/team/asset identifiers server-side. Organization-global approved memory is not platform-public memory. Workspace scope and agent-private scope are discriminated DTOs with mandatory corresponding IDs; impossible combinations fail schema validation.

Current MemoryCore documentation distinguishes chat/skill storage and knowledge metadata from Wiki/CodeGraph content handled by MemoryKnowledge. Its v3 data plane requires scoped user/team/agent identity. MemoryCore's FTS5 health must be checked, since an unavailable text index can look like empty retrieval. These are upstream observations; Brain still needs negative ACL and restore tests on an exact revision. [MemoryCore documentation](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/MemoryCore/README.md)

Default deployment uses one private memory service with organization/workspace mappings, only after G04. For hostile tenants or insufficient upstream isolation, use separate service instances/volumes/keys. Gateway filtering alone is not proof that service-side arbitrary asset access is isolated. Do not enable generic upstream tool dispatch with unchecked tool names/parameters.

## Retrieval contract

Authorize scope before querying and reauthorize returned asset IDs against current mappings. Cache key includes organization, workspace/scope, principal/delegation class, query digest, source versions and ACL generation. Revocation increments ACL generation and invalidates access immediately at the gateway. An unavailable ACL authority denies private retrieval, including cached content.

Default query: top 8 items, at most 12,000 characters and a context token budget; deduplicate by source/version and include source ID, timestamp, scope, classification, provenance and relevance signal. Source confidence is metadata, not proof of correctness. Stale/revoked/deleted assets cannot enter prompts. A cache miss or unavailable index is distinguished from an authorized empty result.

Memory is labeled untrusted advisory context. A retrieved “always approve production” instruction has no policy effect. Source code facts carry repository/revision; verify against the current checkout before changing code. PII/secret filtering occurs before capture/publication, not just after retrieval. Capture completed sanitized task facts by policy; do not automatically proxy every provider conversation through TencentDB's optional proxy.

## Asset lifecycle and promotion

Candidate → indexed → reviewed → published → deprecated/revoked. Async Wiki/CodeGraph indexing shows pending/failed/ready and source watermark; UI never implies immediate availability. Private Git URL/SSH credentials are disabled until the pinned service's private-repository path and redaction pass. Importing a repository does not authorize outbound indexing to an unapproved provider.

Promotion requires source evidence, content digest, destination scope, classification review, secret/PII scan, license/source rights and authorized reviewer. Revocation is a durable tombstone propagated to caches/indexes; deletion operations are separately audited and respect retention/legal holds. If an upstream component cannot delete/restore a class of asset, expose the limitation and disable claims of complete deletion/portable backup.

Executable Skills/tools are separate from memory assets. A published wiki skill is still instructions. To become an executable trusted tool it must enter the Git package review/test/release pipeline with explicit permissions. TencentDB membership or asset ownership never grants Governor roles.

## Rule of Three

Count three distinct original successful runs with verified equivalent operations; retries and nested calls from one parent count once. Normalize typed operation identity plus parameter shape, not raw shell substring similarity. Never retain secrets in signatures. Before proposing a new package, search existing tool contracts for equivalent capability. Ambiguous groups require human review.

Insert a unique candidate signature transactionally; concurrent observations produce one candidate. Candidate includes the three evidence references, suggested typed inputs, effect class, existing alternatives and test fixtures. It remains quarantined. Automatic publication, privilege expansion or updating active tools from runtime code is prohibited. After publication measure reuse and correctness; repeated use is not evidence that a flawed operation is safe.

## Connectors and packs

Connector port separates `probe/read/list/observe` from `mutate/reconcile`. It defines rate limits, auth references, target canonicalization, idempotency semantics, pagination/cursor rules, event version and deletion behavior. Webhook handling authenticates signatures against raw bounded body, rejects replay and uses an inbox. Polling uses overlap windows and deduplication, not just last-seen timestamp, to handle delayed events. Remote 429 honors Retry-After within declared deadline/budget.

Pack manifests pin workflows, tools, agents, schemas and evaluators. Within the current build, disabling a pack stops new work while existing pinned work finishes or is explicitly cancelled with evidence preserved. No pack can redefine the global security floor. Historical executable release retention, cross-version run conversion and pack upgrade migration are excluded until requested.

| Pack | Required behavior and acceptance |
|---|---|
| Onboarding | Read-only repo/environment discovery; classify fact/assumption/unverified; generate Git proposal, interview questions and evidence; active workspace only after validation |
| Support | Poll/webhook dedupe; diagnose with linked evidence; draft reply; exact approved publication; one evidence-request comment per missing-evidence signature |
| SRE | Scheduled read-only observations; freshness/unknown separate from healthy; debounce alert/recovery; propose exact remediation, never auto-mutate production |
| Delivery | Version-pinned dossier/checklist; GO/GO-with-reservations/deferred/NO-GO plus traceable evidence; human release approval independent of model recommendation |
| Eval | Golden sanitized cases, deterministic oracles, calibrated optional judges, confidence/sample-size reporting, no train/test leakage |

SLA computation is deterministic from immutable status intervals and a versioned business calendar. Record Keyrus/client/Hub responsibility changes, pause rules, reopen rules, source timestamps and late-event corrections. Distinguish first response from resolution and calendar time from business time. Recompute affected periods idempotently on late/corrected events; preserve old published metric version for audit.

Reconciler observes desired Git state and target facts, debounces drift, records evidence and proposes governed work. It has no universal repair permission. Periodic scans, connector sync, alerts and memory indexing have persistent cursors and separate small house budgets so a long agent session cannot block them.
