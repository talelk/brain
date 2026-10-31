# Keyrus Brain — implementation prompt

Use the following prompt when asking a coding model to implement the platform. Preparing this file does not itself start product implementation.

---

Implement Keyrus Brain in this workspace from the current architecture, configuration and contract pack. Deliver the working target system, not another plan, static UI showcase or collection of placeholder services. Inspect the workspace first and continue from real existing work; do not assume that a task ledger entry or a green documentation check means the runtime already exists.

Read `docs/implementation/23-runtime-status.md`, `docs/implementation/24-native-identity.md` and `docs/implementation/25-evaluator-authority.md` before continuing existing implementation. They distinguish verified native identity/evaluator behavior from remaining Mastra, runner, contract, UI and live-certification work. Preserve verified authority boundaries while replacing incomplete runtime paths.

## Governing implementation policy

The user has explicitly waived **compatibility, historical migration and incremental-change constraints until they explicitly say otherwise**. This instruction overrides conflicting development-process guidance in older specifications, examples and task cards.

- Do not preserve old behavior, APIs, file layouts, schemas, configuration grammars or internal implementations for compatibility.
- Do not build migration scripts/frameworks, historical import converters, backfills, compatibility facades, deprecated aliases, dual reads/writes, rolling-upgrade coexistence or parallel legacy implementations.
- Make breaking changes when they improve the target design. Change related modules, contracts, generated types, configuration, callers and tests together. Replace and remove obsolete logic instead of retaining a second path.
- Do not restrict work to one task, one layer, a tiny patch or a separately deployable increment. Batch related work and complete coherent workflows across boundaries. Internal checkpoints and dependency ordering are useful; preserving intermediate behavior and staging old-to-new cutovers are not requirements.
- Continue through the authorized implementation scope rather than stopping at a task/slice boundary or asking permission for routine implementation choices. If technical blockers remain, work on independent parts and report precise blockers without inventing APIs or claiming unsupported features work.
- Do not reinstate any waived constraint unless the user explicitly requests it. A request to test, fix, verify or continue is not such a request.

This policy does not remove target-system correctness. Initialize fresh databases using the current schema and generate the selected vendors' required initial tables. Verify that selected dependencies work together. Keep current-build protocol validation, same-version crash recovery, exact approvals, leases/fencing, immutable runs/evidence and backup/restore in the current format. Preserve unrelated user work and non-disposable data; no data deletion/reset is authorized by the waiver. Use disposable fixtures for fresh-state testing.

Product ports such as WorkflowEnginePort, EngineAdapter and MemoryGateway remain required replaceability boundaries. They are not legacy compatibility shims. Configuration revisions within the current implementation remain immutable for running jobs; no historical binary/SDK coexistence or cross-version run conversion is required.

## Read these sources in order

1. `AGENTS.md`, including `/home/talel/.codex/RTK.md`: prefix shell commands with `rtk`.
2. `contracts/v1/implementation-policy.json` and this prompt.
3. `IMPLEMENTATION.md`, then documents `00`, `01`, `18` and `22` under `docs/implementation/` once for orientation. Use `scripts/implementation_context.py` and `contracts/v1/task-packets.json` to read the owning boundary documents for the related tasks being implemented; do not load the entire consolidated specification into every request.
4. `contracts/v1/brain.schema.json`, generated DTOs, `ports.ts`, OpenAPI, registries, state machines, `architecture.json` and `ui-foundation.json`.
5. `examples/v1/config/brainconfig.yaml`, `web-build.json`, workflow/config examples, consumer Vite/CSS references and reference SQL.
6. `docs/implementation/12-implementation-tasks.md` as the coverage/dependency checklist and `11-acceptance-and-edge-cases.md` for acceptance oracles.

For the selected local Qwen/OpenCode environment, use the root `opencode.json` and document `17-opencode-execution.md`. Run the secret-safe profile preflight, use the exact configured model ID, and qualify real tool calls/checkpoint recovery in a disposable workspace. The static profile and declared context limits alone do not prove model quality. Initialize the typed ledger/checkpoint examples for actual product work. The root prompt remains the whole-system objective across context compactions and related task batches.

Documents 18–21 close the integration decisions, authorization/data model, launcher/connector protocol, golden fixture and screen recipes. Use `dependency-baseline.json` and its resolver for exact artifacts; use `authorization-matrix.json`, `acceptance-oracles.json`, `scenario-catalog.json` and `ui-screen-contracts.json` as independent coverage inputs. A failed dependency resolution or unrun integration is an explicit blocker to that capability, never permission to fabricate versions, APIs, credentials or test results.

Original v4 inputs are historical context. Current user instructions take precedence. Machine contracts, state machines, implementation policy and prose must agree; when implementation proves a proposed contract is wrong, correct the target contract and all affected consumers/tests in the same body of work. Record the reason. Do not add a compatibility path or loosen a security invariant to avoid fixing a mismatch.

## Architecture to implement

**Git declares. SQLite records. TencentDB remembers. Governor authorizes. Mastra coordinates. Runners execute. Independent evaluators verify.**

The product has eight fundamental pillars: Workspace, Plan & Board, Agent Sessions, Multi-Agent Collaboration, Scheduling & Automation, Governance & Verification, Autonomous Capitalization, and Configuration & Studio. The primary model is Objective → PlanVersion → WorkItem → Execution. Brain is UI-first: every common operation is available through typed Web/Governor flows without mandatory YAML, commits or terminal commands, while Git remains the published-definition authority and CLI/MCP/YAML remain equivalent advanced interfaces.

Implement a **modular monolith**. Governor is one process/deployment with internal modules and in-process public function calls. Use `contracts/v1/module-layout.json`; keep only `packages/contracts` as a shared package. Domain logic, repositories, Mastra/TencentDB/connector adapters and Brain UI compositions stay in their owning application folders. Preserve the runner/launcher isolation boundary. Do not create per-module services, internal HTTP/brokers, a universal plugin system or extra packages merely to mirror the architecture diagram. This simplifies packaging while retaining the full requested functional scope.

Use the three logical planes and the separate experience/client layer in `architecture.json`:

- Experience: SolidJS plus **NewUI**, responsive Web/PWA/TV, Brain CLI and MCP. Human/agent interfaces share Governor command/query handlers.
- Control: one active TypeScript Governor using Hono and Better Auth; policy, approvals, dispatch, configuration compiler, workflow bridge, scheduling, reconciliation and memory gateway.
- Data: Git declarations, global `control.db`, per-workspace `workspace.db`, separate private `workspace.mastra.db`, content-addressed artifacts and scoped TencentDB knowledge.
- Runtime: registered outbound runner supervisors, isolated job slots, capability-aware admission, Pi/Claude adapters, optional validated ACP, governed Bash tools and independent evaluator attempts.

Keep domain logic pure, application services vendor-neutral and concrete adapters bound at composition roots. Mastra coordinates trusted Governor primitives; it cannot authorize effects or execute privileged tools directly. Runners do not mount central SQLite or hold global workflow authority. TencentDB does not grant permissions. Do not add another mandatory workflow engine, database server, broker or UI framework.

## Build real workflows

Implement the required target across contracts, auth, current-schema persistence, Git/YAML compilation, immutable releases, Mastra dispatch/gates/evaluation and durable waits, runner enrollment/inventory/claims, resource admission, leases/fencing, tool permits, evidence and independent verification. Then complete CLI/MCP/live sessions and the NewUI task flows, scoped memory/promotion, Rule of Three, connectors/packs, reconciliation, current-format backup/restore and operational/performance gates.

Use the task cards to cover all required behavior and the declared optional/deferred scope. They do not force isolated implementation PRs or serial one-card completion. Some source features are explicitly optional or deferred; do not invent support or silently expand the platform to implement those. A required failed gate remains an open requirement even if independent work can continue.

## NewUI requirements

Use six primary areas: Today, Work, Activity, Approvals, Knowledge and Administration. Work includes Plans, Board, Tasks, Schedules, Sessions and Resources; Knowledge includes specialized Studios; Administration includes Git integrations, models, members, runners, policies, storage and releases. Personal security/preferences stay in the account menu. The route index is generated from `ui-screen-contracts.json`. Exact approval recovery uses a captured idempotency key and the dedicated decision-status endpoint; an uncertain response remains recoverable and cannot become an automatic new submission.

Use the current public `@talelk/newui-*` atomic packages and the reviewed source/API baseline in `ui-foundation.json`. Select and verify exact actual package artifacts; source-observed versions are not proof of installability. Do not use historical `@newui/ui` APIs, import library internals, recreate Zag primitives or define another palette/component system.

Use AppShell, PaneLayout and AuthLayout; reuse the documented atoms, molecules, DataTable, VirtualList, KanbanBoard, DataState, filters and overlays. Brain owns ApprovalReview, EvidenceList, PlacementExplanation and other domain compositions. Import semantic CSS once, include Brain composition sources in scanning, use one theme owner, preserve text scaling/focus and provide proper touch targets. Keep charts/editors route-lazy and optional.

Make Today/Bridge, exact approval review, job placement explanations, live sessions, boards/decisions and required pack views functional against real Governor handlers. No fake approval success, static hardcoded operational status or generic optimistic patch may confer authority or mark work Done. Implement mobile navigation and list/detail return behavior at 390/768/1440 widths in both themes. NewUI is not a Frappe backend integration; do not use its Frappe resource client/proxy/cache for Brain data.

## Correctness and recovery requirements

Construct actors from server-verified credentials; enforce organization/workspace scope at every boundary. Treat model output, repositories, memory and runner claims as untrusted. Bind human approval to the exact action, inputs, target/precondition, tool/config/policy digests and expiry. Keep offer reservation, approval consumption and effect permits separate.

Global authority changes commit in short `control.db` transactions. Cross-file coordination uses durable outbox/inbox and idempotent handlers. Enforce runner identity/epochs, current leases, numeric resource reservations and permanent resource fencing counters. Release compute while awaiting humans. Unknown external effects require target-specific reconciliation; never blindly retry them. Verify isolation/credential limits with real denied-path tests.

Completion requires immutable artifact hashes, pinned evaluator inputs and accepted independent evidence. A model's “done”, runner exit 0 or Mastra success is not sufficient. Preserve same-version restart/resume, duplicate wake handling and current-format restore; do not turn these requirements into cross-version upgrade/migration work.

## Dependency and verification discipline

Registry resolution supplies candidates only. Accept one actual dependency cohort after strict peer/engine checks, native/auth imports and a production NewUI build, then freeze that exact lock. Read current runtime/model evidence from `artifacts/implementation/runtime-readiness.json`; source-review flags and historical pending examples do not determine live readiness. A common `VerificationRun` record binds commands, checks, executed cases and raw artifact hashes to the current source/lock. Test runners produce it; a hand-edited passed flag cannot substitute for execution or independent certification.

Inspect actual pinned official documentation for APIs; do not mix versions or invent methods. Keep dependency integration checks and G01–G08 technical gates. These test the selected target dependencies, not compatibility with earlier Brain versions. Update the dependency record/SBOM and report tested platform scope.

Use meaningful domain, contract, integration, security, browser, chaos, restore and performance tests. Reuse/extend existing scenario coverage before adding redundant tests. Run focused checks while working and the required broad gates on the final target. Missing test commands must fail clearly. No fake-green scripts, hidden required skips or automatic visual baseline regeneration. Existing documented release budgets are targets to measure, not results to assert.

The pack verifier validates documentation/contracts only. Installing NewUI, executing Mastra/TencentDB, exercising sandbox enforcement, running browser flows and measuring performance require their actual runtime evidence. Record exact commands, selected/executed scenario IDs, versions, source/dirty-work fingerprint, timing, artifacts and cleanup.

## Working and reporting

Inspect current files and working-tree state before changing them. Keep a durable implementation ledger and checkpoints across context limits; do not restart or discard completed work. Update target contracts and generated artifacts when needed and remove obsolete code. Do not add unrelated redesigns or deployment infrastructure.

Continue until the requested target is implemented and verified, or until an actual external dependency/input blocks all useful authorized work. Routine code edits, local builds and tests do not require another confirmation. Existing production effects, publishing/deployment or non-disposable data changes still require the applicable authorization.

At completion report:

1. Concrete working behavior and entry points.
2. Verification executed, evidence paths and measured results.
3. Required blockers, failed/not-run scenarios and optional unsupported scope.
4. Any target contract changes and why they were necessary.

Do not report migration/backward-compatibility/incremental-rollout deliverables; they remain out of scope until the user explicitly changes this instruction.

Begin by inspecting the workspace and establishing the implementation ledger, then implement. Do not end at a plan or offer to start later.
