# Current evaluator authority and remaining integration

This document describes the 27 October implementation, not full T27/T28/G03 certification. The application remains one Governor modular monolith. The evidence module owns validation and acceptance; coordination uses its public index. Runners report results over authenticated HTTP. SQLite holds authority and durable application records.

## Code and contracts

| File | Responsibility |
|---|---|
| `apps/governor/src/modules/evidence/service.ts` | Bundle/attempt checks, bounded artifact rehashing, evaluator authority, immutable verdicts and retriable finalization |
| `apps/governor/src/modules/evidence/index.ts` | Public module surface |
| `apps/governor/src/modules/workflows/runner.ts` | Current coordination, evidence-triggered evaluator admission, immutable completion and cancellation tombstones |
| `apps/governor/src/modules/configuration/compiler.ts` | Validated evaluator definitions and exact document references in pinned releases |
| `apps/governor/src/application/brain.ts` | Composition, claims, receipts and periodic recovery |
| `apps/governor/src/http/app.ts` | Runner authentication, bounded JSON and canonical verdict ingress |
| `apps/runner/src/tools/invoke.ts` | Normalize actual fixture-tool stdout into Brain checks |
| `apps/runner/src/supervisor.ts` | Execute fixture tool, commit normalized receipt and submit assigned verdicts |
| `contracts/v1/brain.schema.json`, `contracts/v1/openapi.json` | Canonical DTOs and runner operations |
| `apps/governor/schema/workspace.sql`, `sql/reference/workspace.sql` | Current schema including verdict finalization marker |

`POST /runner/v1/evidence` accepts `EvidenceBundle` and returns `{digest}`. `POST /runner/v1/verdicts` accepts `{workspaceId, verdict}`, with a canonical `VerificationVerdict`, and returns `{verdictId, outcome}`. Browser cookies are rejected. Runner identity comes from the current session, never from an actor field in the body.

`EvaluationAssignment` binds bundle digests, evaluator release, required check IDs, check-to-criterion mapping and effective independence. Governor places it in an admitted evaluator job. Sending such an object from a runner cannot create execution authority.

## Implemented lifecycle

1. Author commits a successful receipt and confirms execution cleanup. Its job remains `verifying`; releasing compute and accepting evidence are separate facts.
2. Submission checks registered runner, tenant/workspace, current epoch/fence, exact job/run/config/source revision/workflow digest, receipt, cleanup, declared tool reference and consumed approval references. Changed bundle-ID reuse and duplicate criterion/check pairs are rejected.
3. Artifact associations, verified metadata and bytes must match. Check artifacts must belong to the bundle. Rehash with a 64 KiB buffer; reject symlink files and changed content/size; cap total bundle artifacts at 100 MiB. Asynchronous hashing/admission still needs production profiling.
4. An explicit dependent `eval` primitive is admitted once its author inputs have submitted bundles. Governor binds committed outputs and exact digests, resolves the evaluator from the run's pinned release and applies the stronger workflow/evaluator independence requirement. Authors need not succeed before their evaluators start. Ordinary dependency advancement does not create an unbound evaluator.
5. L1 requires a separate admitted attempt. L2 additionally requires distinct runners and exactly one current Governor-verified `trust:domain:<id>` on each side, with distinct values. Labels/groups alone are insufficient. Hello `trust:` claims remain unverified. Tests supply explicit trusted attestations; production provisioning still needs a real verifier. L3 is refused until an external attestation implementation exists.
6. The admitted evaluator executes the real fixture tool and commits normalized checks in its receipt. The fixture adapter translates its documented `{id, passed}` tool schema into `CheckResult`. Omitted/malformed/unexpected checks cannot silently pass.
7. Acceptance verifies actual evaluator attempt, runner epoch/fence, lease, cleanup, current workflow, pinned release/group/independence, exact assigned bundle, all required checks, criterion/oracle, matching committed result and unchanged durable inputs. Outcome must agree with checks. Self-evaluation, invented attempts and empty-check success are denied. Identical replay returns the same receipt; changed verdicts conflict.
8. Passed checks cannot reconcile external effects. Unknown guards or unreconciled permits prevent success. Effect declarations require the author's permit and an authoritative operation receipt. A general verdict never clears resource guards.
9. Author/evaluator states and workflow completion are applied idempotently. No evidence is automatically attached to unrelated cards. Explicit card/criteria acceptance remains to be implemented.

Multiple author inputs require consistent check-to-criterion mappings within one assignment. General revisions and hierarchical evaluation policies remain unfinished.

## Crash and replay

Workspace acceptance first commits the immutable verdict/bundle state. `finalized_at_ms=NULL` records outstanding application. The control transaction deduplicates by verdict ID and canonical payload digest in its existing inbox and checks the author's current fence. Step completion stores an output digest and rejects conflicting completion. The final workspace marker follows those projections.

Periodic recovery retries finalization and evidence-triggered admission under stable execution keys. A fault after control/workflow completion but before the final marker cannot create another verdict/job or replace its output. Cancellation cannot resume work from a late verdict. Suspended/restored workspaces are not executed automatically. These are separate commits with durable retry, not cross-WAL atomicity.

The recovery scan has bounded batches and a simple active-workspace scan. Durable fair paging, poison-record diagnostics and large-workspace performance qualification remain required.

## Verification and practical limits

`tests/integration/evidence.test.ts` serializes requests through real Governor HTTP handlers using a scoped in-process transport. It enrolls both runners, executes actual Bash/Python fixture tools and exercises admission, receipts and acceptance. Cases include altered author facts, foreign/self/invented evaluators, missing/changed checks, stale epochs/fences, revoked/same-domain trust, artifact tampering, unresolved effects, cancellation and a finalization fault. This proves handler/protocol behavior without claiming socket, TLS or Compose behavior.

The real-socket `tests/integration/golden.test.ts` now uses genuine admitted evaluation instead of fictional evaluator IDs. Localhost binding is denied here (`EPERM`), so that required wire test remains failed. No skip or green gate substitutes for it.

```sh
rtk proxy pnpm verify:fast
rtk proxy pnpm exec vitest run tests/integration/evidence.test.ts tests/integration/scenarios2.test.ts
rtk proxy pnpm test:integration
rtk proxy pnpm lint
rtk proxy pnpm build
```

## Required next implementation

- Replace the homegrown coordinator with the real Mastra port and durable registered primitives. Preserve evidence-triggered admission/completion semantics. A standalone lowering probe is not the product engine.
- Complete artifact upload ownership, streaming publication, primitive/tool executable provenance and runner-produced author bundles. Tests currently assemble author bundles from authoritative stored facts.
- Close JobOffer/response conformance: runtime offers still carry an inline payload beyond the original artifact-only schema. Unrelated valid examples cannot certify runtime responses.
- Add production trust-domain attestation, read-only evaluator artifacts, package validation, launcher enforcement and complete runner replay/cancellation/deadlines. Fixture subprocess execution does not certify isolation.
- Implement explicit card/run/criteria bindings and all required criteria before Board Done. Removing blanket attachment prevents accidental authority; it does not complete Board acceptance.
- Finish revisions, incomplete/rejected resubmission, hierarchical evaluations, external L3 attestations, connector evidence and full backup/restore inventory.
- Produce independent gates, live wire/browser/kernel tests, workload measurements and OpenCode/model qualification.

Only fresh current-schema initialization is provided. No historical migration, compatibility facade, dual write or old/new coexistence was added. Existing nonmatching data directories are preserved and refused.
