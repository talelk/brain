# 22 — Readiness, coverage and implementation handoff

## What this extension closes

This is a detailed implementation plan and contract pack, with executable checks for its own fixtures. It is not an implemented Brain service. [readiness.json](../../contracts/v1/readiness.json) declares requirements and their concrete artifacts. Current runtime/model status is derived separately in [runtime-readiness.json](../../artifacts/implementation/runtime-readiness.json) from verified evidence records, without forcing an eternal pending state. Missing runs remain not-run; passed records are accepted only with current source/lock, successful commands, all required checks/cases and intact artifact hashes.

The target is a modular monolith with one Governor, internal module folders, one shared contracts package and isolated runner/launcher executables. Full functionality remains in scope. Five main navigation areas group all routes. The extension supplies selected integration decisions, an explicit dependency resolution/freeze procedure, complete runner proof and step-up shapes, typed harness payloads, reconciliation and command recovery, role matrices and authorization SQL, a closed golden configuration, literal failure-path oracles, 100 scenario ownership records, 50 focused work packets, NewUI recipes/screen bindings, an OpenCode v2 project profile, durable ledger/checkpoint formats, qualification cases, launcher/connector contracts and bootstrap/runbook requirements.

`member.grant` and `member.revoke` close the settings-to-command gap. Both use expected workspace directory version; grant requires organization-admin, revoke also permits security-admin. The target must already be a member of the same organization. Approver assignment requires an explicit named human grant and audited reason; membership changes increment the workspace directory version and organization auth generation and invalidate affected caches/streams. These are live access-control records, not Git workspace definitions. A general agent cannot invoke them. Their typed lifecycle events are `membership.granted` and `membership.revoked`.

## Entry sequence for Qwen

1. Run the static profile preflight; resolve any native loader/environment failure before assuming instructions are loaded by OpenCode. Run the six qualification tasks on a disposable workspace, three clean repetitions each.
2. Use the root prompt, read the policy and current ledger, and request task packets for the related work being implemented. Keep one objective across sessions.
3. Establish actual dependencies using the baseline resolver, inspect exact package artifacts and peer/engine constraints, create the product workspace manifests and frozen lock, then run G01/G02 and the required integration probes. Pending vendor credentials never justify a fake successful adapter.
4. Implement the target across the dependency checklist. Batch related changes freely; update contracts, SQL, callers, generated DTOs, configurations and tests together. No compatibility/migration/incremental-change obligations are introduced.
5. Verify user workflows against the real Governor and runner boundary, including denied paths and crash recovery. Keep fixture/vendor/kernel/browser/performance evidence distinct. Only then mark matching task/gate records passed.

The implementing model must not consume every source document in every call. The packets name the exact owning files and tests. Re-read the canonical schema for the active boundary, keep recent failures visible and checkpoint before context loss. A 262k configured context window does not remove reasoning, tool-call or instruction-following limitations.

## Remaining live prerequisites, honestly recorded

| Requirement | Present evidence | What completes it |
|---|---|---|
| Exact working dependency set | Candidate versions/source observations, deterministic resolver; registry DNS failed in this shell | Successful artifact resolution, reviewed frozen install, native/peer checks, SBOM and G01 |
| OpenCode native config load | Binary 2.1.4 and sanitized static profile checks pass; background service exits code 1 here, with the same failure outside this project | Healthy native loader on the execution host and effective model/instruction/permission verification |
| Actual local Qwen competence | Configured local model/declared limits observed; no model calls sent | Six real disposable qualification tasks, three repetitions, context/compaction recovery and failure evidence |
| Vendor/kernel integrations | Required probes, data and acceptance paths specified | G02–G07 against actual libraries, services, provider credentials, sandbox and disposable targets |
| Product UX/performance | Source-reviewed NewUI recipe, screen contracts and budgets | Installed recipe compile, real responsive/browser workflows, runtime load/restore tests and G08 measurements |

These are execution prerequisites and evidence gaps, not unspecified architecture choices to hand to Qwen. Missing real server URLs, application credentials, private repositories and production targets are operator inputs: never invent them or request unrestricted credentials merely to run a fixture. Use the supplied no-network golden release and deterministic adapters for independent implementation until the actual target input is available.

## Plan validation and distribution

Run `rtk python3 scripts/generate_implementation_indexes.py`, `rtk python3 scripts/generate_contract_types.py`, `rtk python3 scripts/verify_implementation_pack.py`, and `rtk python3 scripts/build_implementation_pack.py`. The main verifier includes the readiness extension checks: registry/matrix/view parity, complete task/scenario coverage, fixture digests and reference closure, literal oracle integrity, selected authorization SQL rejections and resolver success/failure behavior against local metadata fixtures. Those checks prove pack coherence only. Generated example expected data must not be regenerated from the implementation under test.

The ZIP includes the OpenCode profile, prompts, new contracts, golden release, scripts and sanitized environment evidence. It contains no model credentials and no copied global OpenCode config. The combined Markdown includes documents 00–22. Root original inputs remain unchanged for provenance.

Full target completion still means all required behaviors in T01–T50, all applicable E001–E100, G01–G08, fresh same-version recovery/restore and independent release evidence. An explicitly deferred feature can stay disabled with a clear disposition. A missing required feature, fabricated benchmark, unrun browser case or model self-report cannot be called implementation-ready execution evidence.
