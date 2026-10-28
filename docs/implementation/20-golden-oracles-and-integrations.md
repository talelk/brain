# 20 — Golden release, integration oracles and launcher protocol

## A closed local configuration

[golden-release](../../examples/v1/golden-release/manifest.json) is a complete deterministic **tool → independent evaluator** workflow release. Its Tool, Evaluator, Policy, WorkspaceType, RunnerGroups, Workspace, BrainConfig, schemas and scripts all exist and their release references resolve to actual byte digests. It uses the fixture environment, no network repository, no provider key and no synthetic all-`a` digest. Runner registration and human membership remain operational bootstrap records, never fabricated Git state.

Run `rtk python3 scripts/build_golden_release.py --check` to verify freshness; run without `--check` only when intentionally changing the canonical fixture. Its package digest is SHA-256 over a canonical ASCII JSON list of relative path, mode and SHA-256 bytes, sorted by path, excluding the package index itself. Config release refs address exact definition bytes. The release manifest indexes definitions and packages and closes all `ReleaseRef` and schema/instructions paths. Production compiler hashing remains the canonical contract in document 03; this pack builder is a small fixture construction tool, not the production compiler.

The workflow dispatches fixture.echo with `{message:"Brain fixture"}` and evaluates the result in a separately registered evaluator runner. Required literal output is `{message:"Brain fixture"}`. The evaluator checks both the exact message and its 13 UTF-8 bytes. Expected check IDs are `echo-message` and `echo-bytes`; both must pass. The evaluator is a different attempt/runner trust group and cannot alter source fixtures. Neither workflow exit nor test runner return code alone authorizes Done.

This golden release proves configuration closure and deterministic tool behavior. It does not prove Mastra, real runner transport or sandbox enforcement until T29/T30/T21 run it through the actual system. The original examples remain shape illustrations; do not mistake their placeholder resource references for this closed release.

## Literal oracles and scenario ownership

[acceptance-oracles.json](../../contracts/v1/acceptance-oracles.json) supplies fixed initial facts, stimuli, crash points and expected observations for critical authority paths, plus canonical JSON byte/hash vectors. The expected values are authored independently of the future product handlers. Tests must load these values, invoke the actual boundary, read authoritative state and compare. Never generate expected values from the production reducer under test.

[scenario-catalog.json](../../contracts/v1/scenario-catalog.json) maps every E001–E100 to a suite, task owner, trigger and required observation. The E table is the complete scenario inventory, not 100 implemented tests. An executable suite must report the exact scenario IDs it selected and actually executed; missing implementations fail required coverage rather than become a skip. Detailed golden traces cover a critical subset; the remaining scenarios require real tests with their own fixtures, including actual network/kernel/vendor tests. `verify_readiness_additions.py` validates the pack's internal records and selected SQL denial cases, never certifies the product from a reference simulation.

[crypto-vectors.json](../../contracts/v1/crypto-vectors.json) includes the published RFC 8032 Ed25519 test vector and an independently calculated opaque-permit HMAC vector. `check_crypto_vectors.mjs` verifies signing, verification, tamper rejection and deterministic permit derivation with Node's built-in crypto. This checks primitive bytes, not runner authentication/replay handling; the actual challenge/epoch transaction still needs its integration/security tests. The included private seed is public standard test material and must never be used for a real identity. [RFC 8032 test vectors](https://www.rfc-editor.org/rfc/rfc8032#section-7.1)

Harness qualification additionally checks native OpenCode tool calling and compaction. A fixture model is useful for deterministic workflow tests but cannot qualify the real Qwen endpoint. Keep those evidence categories separate. A single successful coding example does not prove broad reliability; record three repetitions, failure counts and the actual context size tested.

## Proposal → authority → tool result

1. Harness emits typed `tool.proposed` with proposal ID, declared tool ReleaseRef, schema-valid input, canonical input digest and stable target.
2. Adapter pauses this tool call. The model's proposal cannot execute its own shell, supply a permit or approve itself. Match its declared tool against the session allowlist; preserve the vendor call ID in runner-local state.
3. Governor reconstructs the exact ActionSubject from authoritative config, policy, target readback and validated input. If policy requires a human, create one immutable approval request and release the agent slot when suspension is durable. A native vendor call waiting in memory is not durable suspension.
4. Once approved, schedule the fixed tool operation on the appropriate runner. The broker asks for one online opaque permit and revalidates it immediately before execution. Tool/target/approval IDs must match; input hash mismatch denies.
5. Capture the receipt and evidence. Only an accepted typed `tool.result` maps back to the original proposal/call ID; never synthesize a success tool response on timeout.
6. If native paused calls cannot survive process restart, preserve a checkpoint and launch a new harness attempt with the verified tool receipt as context. Do not replay the external tool call or pretend vendor session files are interchangeable.

An exact permit retry preserves the original grant and expiry; it never silently extends authority. After expiry, deny effect start and reconcile whether any start/effect occurred. A consumed approval does not become reusable because the response was lost. Proven absence can support a new reviewed proposal, not automatic replay of a non-idempotent write.

`EngineEvent` is now a discriminated union. Unknown kinds and malformed payloads fail at the adapter. `usage.accounting=delta` is charged once by usageId; `final-total` reconciles the session total rather than adding the same tokens twice. Token/cost counters are integer and nonnegative. The text channel is explicitly provisional. Large output is an ArtifactRef; private raw vendor events are bounded/redacted artifacts, not another untyped authority channel.

Enforce actual UTF-8 event bytes as well as schema character limits. Inline harness tool proposals must fit the 32 KiB event limit (reserve wrapper overhead; default input budget 24 KiB); an oversized proposal is a structured input error and never executes. Direct broker invocations retain their declared 64 KiB input limit. Do not truncate JSON or silently execute a different input to fit transport.

## Constrained launcher wire protocol

Brain launcher exposes HTTP over a Unix socket to the runner supervisor account only. Socket directory 0700, socket 0600, distinct account per trust domain; use peer credentials where available in addition to permissions. Rootless Docker's own socket is accessible only to the launcher service, never to a job or the supervisor container. A separate scoped launcher token file may authenticate a containerized supervisor if Unix peer identity does not survive that topology. The launcher refuses TCP binding by default.

| Operation | Request | Required response / idempotency |
|---|---|---|
| `GET /v1/health` | none | Kernel/cgroup/engine/profile capability inventory; not a blanket safety assertion |
| `POST /v1/sandboxes` | `LauncherCreate` | `LauncherInspection`; requestId + exact body hash returns same owned sandbox; changed body conflicts |
| `GET /v1/sandboxes/:id` | owned ID | Inspection with state, process termination and cleanup separately |
| `POST /v1/sandboxes/:id/stop` | `{requestId,graceMs}` (0–10,000 ms) | TERM, bounded grace, KILL, cgroup/daemon cleanup, evidence; duplicate stop stable |

Create accepts only a named **preinstalled** image/profile and owned worktree ID, not arbitrary entrypoints, argv, mounts, devices, capabilities or environment. Launcher resolves confined paths itself, rechecks symlinks, validates immutable image digest and injects a fixed entrypoint. Resource demand must fit the approved profile, with CPU/memory/PIDs/disk/open-files bounds. Drop capabilities, no-new-privileges, read-only root, ephemeral scratch and tenant-scoped worktree; pin seccomp and user mapping. Inspect reconciles after launcher restart by immutable ownership labels, not merely by PID.

Network profiles: `none` uses Docker `NetworkMode:none`; `model-only` attaches only to an internal network with a dedicated allowlist HTTP CONNECT proxy; `read-target` and `privileged-target` have separate preinstalled proxy/identity allowlists. The proxy validates DNS results on every connection, blocks redirects/rebinding to disallowed addresses and denies arbitrary CONNECT ports. It must not accept an agent-supplied HTTP proxy bypass list. Verify no direct route to host/metadata/other job networks, including IPv6. Rootless engine/proxy topology must pass G06; inability to enforce it blocks that profile. Do not claim raw kubectl access works through an arbitrary HTTP proxy without testing its actual TLS/CONNECT behavior.

No slot reuse until stop confirms processes are dead and writable/credential material is removed. A stopped launcher process or lost Docker response is `unknown`, not proof of cleanup. Persist launcher ownership journal locally; reconcile orphan containers and unresolved mounts at startup. Compute capacity release and unresolved target-effect guard release are separate decisions.

## Real reference connector: GitLab issues/notes

Use direct HTTP with a named connector config for server URL and numeric project ID. Credentials are secret references. Canonical ticket identity is `(normalized-server-origin, project-id, issue-iid)`, never title or project path alias. Read uses `/api/v4/projects/:id/issues/:issue_iid`; notes list uses its `/notes` subresource. The adapter validates bounded JSON against its own pinned response schema, normalizes to Brain DTOs and preserves source `updated_at`/remote IDs. [Issues API](https://docs.gitlab.com/api/issues/), [Notes API](https://docs.gitlab.com/api/notes/)

Polling uses a persisted overlap window, stable remote IDs, bounded pagination and dedupe. For the first reference adapter, poll rather than require webhook ingress. Honor Retry-After and global/per-connector rate reservations. Do not assume an arbitrary GitLab version supports the same filters or idempotency headers; record the observed API version/capabilities in integration evidence.

Publishing uses the exact approved UTF-8 note body and numeric target; send once through the broker with a least-privilege service identity. The documented note-create API does not establish exactly-once or conditional-create semantics. Default classification is `idempotency:none`, reconcile supported. Lost response leaves unknown; list/readback can identify a returned remote note ID or a uniquely matching authorized body/author/time window, but an ambiguous match cannot clear the guard. Do not add an invisible nonce to the note unless that exact text was approved. Do not retry a timed-out POST merely because the note was not visible on the first read. Production enablement requires a real disposable-project probe, credential scope verification and target risk acceptance; missing operator credentials remain a named blocked input.

GitLab is the complete reference adapter, not an assertion about the user's actual ticket vendor. Other ticket/CRM/ERP systems use separate feature contracts; a generic `JsonValue` method is not permission to ship an unvalidated remote adapter.
