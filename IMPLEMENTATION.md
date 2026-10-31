# Keyrus Brain v4.2 implementation pack

Prepared 27 October 2026. This pack consolidates the supplied v4 architecture and RFC-041 runner amendment. The repository now also contains a runtime implementation under development. Specifications, contract checks, fixture tests and adapter probes do **not** certify production readiness. See the [current implementation audit and continuation](docs/implementation/23-runtime-status.md) before relying on earlier completion labels.

**Git declares. SQLite records. TencentDB remembers. Governor authorizes. Mastra coordinates. Runners execute. Independent evaluators verify.**

**Product vision:** Brain turns intentions into versioned plans, WorkItems and coordinated executions, then capitalizes reusable knowledge and capabilities. Its eight pillars are Workspace, Plan & Board, Agent Sessions, Multi-Agent Collaboration, Scheduling & Automation, Governance & Verification, Autonomous Capitalization, and Configuration & Studio. The Web UI is the primary creation/administration experience; GitOps remains underneath for published definitions, with no mandatory YAML or terminal for common operations.

**Deployment model: modular monolith.** One Governor contains the internal product modules. The shared workspace package is `packages/contracts`; Web/CLI are thin clients, and runner/launcher remain isolated executables. [Module layout](contracts/v1/module-layout.json) defines the target folders. Full functional scope and the user's direct-target implementation policy remain unchanged.

**UI foundation:** use [NewUI](https://talelk.github.io/newui/) and its public `@talelk/newui-*` packages for Brain Web, PWA and TV. [NewUI integration](docs/implementation/16-newui-integration.md) specifies package ownership, component mapping, styling, Governor data adapters and acceptance gates. Brain composes product workflows on NewUI.

**Implementation policy, until the user explicitly changes it:** build the target directly. No backward/forward compatibility work, historical migrations, compatibility shims, rolling-upgrade coexistence or incremental-change constraints. Breaking coordinated changes are allowed; task cards are a coverage/dependency checklist, not a one-task-at-a-time or deployable-intermediate-state requirement. Target correctness, same-version recovery, fresh schema initialization and dependency integration checks remain required.

Use the [ready-to-use implementation prompt](IMPLEMENTATION_PROMPT.md) and [workspace instructions](AGENTS.md). Start with [the audit and decisions](docs/implementation/00-audit-and-decisions.md), then use [the implementation checklist](docs/implementation/12-implementation-tasks.md). Unresolved technical gates block their dependent capability, not all independent implementation work. The [machine-readable policy](contracts/v1/implementation-policy.json) records the user's instruction.

| Document | Purpose |
|---|---|
| [00 Audit and decisions](docs/implementation/00-audit-and-decisions.md) | Conflicts, corrections, constraints, validation gates |
| [01 Architecture and modules](docs/implementation/01-architecture-and-modules.md) | Ownership, dependency direction, exact target file layout |
| [02 Transport and commands](docs/implementation/02-transport-and-commands.md) | HTTP, MCP, CLI, idempotency, errors, events |
| [03 Configuration and workflows](docs/implementation/03-configuration-and-workflows.md) | One YAML grammar, compiler, IR, graph semantics, Mastra bridge |
| [04 Persistence and recovery](docs/implementation/04-persistence-and-recovery.md) | Transactions, SQL ownership, outbox, crash recovery |
| [05 Authorization and security](docs/implementation/05-authorization-and-security.md) | Actor identity, exact approvals, grants, credentials, isolation |
| [06 Runners and scheduling](docs/implementation/06-runners-and-scheduling.md) | Enrollment, placement, leases, fencing, resource admission |
| [07 Harnesses and tools](docs/implementation/07-harnesses-and-tools.md) | Pi/Claude/ACP, checkpoints, budgets, portable Bash tools |
| [08 Evidence and memory](docs/implementation/08-evidence-and-memory.md) | Verifier independence, TencentDB isolation, promotion, packs |
| [09 UX and UI](docs/implementation/09-ux-and-ui.md) | Routes, interactions, design tokens, mobile, accessibility |
| [10 Performance and operations](docs/implementation/10-performance-and-operations.md) | Workload targets, benchmarks, deployment, backup and runbooks |
| [11 Acceptance and edge cases](docs/implementation/11-acceptance-and-edge-cases.md) | Scenario inventory, security, chaos, browser and performance gates |
| [12 Implementation tasks](docs/implementation/12-implementation-tasks.md) | Coverage/dependency checklist; related work may be batched across modules |
| [13 Verified library references](docs/implementation/13-library-reference.md) | Official documentation, adoption decisions, limitations |
| [14 Implementation recipes](docs/implementation/14-implementation-recipes.md) | Transaction algorithms, integration probes, worked walkthrough |
| [15 Requirements traceability](docs/implementation/15-requirements-traceability.md) | Presentation parity, v4 acceptance mapping, deferred features |
| [16 NewUI integration](docs/implementation/16-newui-integration.md) | Required UI foundation, pinned source review, public exports, data and styling integration |
| [17 OpenCode and local Qwen](docs/implementation/17-opencode-execution.md) | Exact local model/profile, preflight, context packets, checkpoint protocol and qualification |
| [18 Closed decisions and bootstrap](docs/implementation/18-closed-decisions-and-bootstrap.md) | Selected integrations, dependency freeze algorithm, host/bootstrap and exact live gate evidence |
| [19 Authorization and data completion](docs/implementation/19-authorization-and-data-completion.md) | Role matrix, additional current SQL, step-up/runner proof, reconciliation and query behavior |
| [20 Golden oracles and integrations](docs/implementation/20-golden-oracles-and-integrations.md) | Closed digest-pinned fixture, literal failure oracles, launcher and real connector protocols |
| [21 UI recipes and screen oracles](docs/implementation/21-ui-recipes-and-screen-oracles.md) | Real NewUI public props, route data/actions and responsive workflow expectations |
| [22 Readiness and handoff](docs/implementation/22-readiness-and-handoff.md) | What is specified, execution sequence, remaining measured prerequisites and honest status |
| [23 Runtime status and continuation](docs/implementation/23-runtime-status.md) | Current code audit, verified repairs, runtime limits and concrete remaining implementation |
| [24 Native identity](docs/implementation/24-native-identity.md) | Implemented native auth, strong verification/recovery, private CLI and client contracts |
| [25 Evaluator authority](docs/implementation/25-evaluator-authority.md) | Authenticated bundles, admitted evaluators, immutable verdicts, recovery and remaining integration |

Machine-readable material:

- [JSON Schema authority](contracts/v1/brain.schema.json), [generated TypeScript DTOs](contracts/v1/brain.generated.ts), [adapter ports](contracts/v1/ports.ts).
- [OpenAPI transport surface](contracts/v1/openapi.json), [command and event registry](contracts/v1/registry.json), [state transitions](contracts/v1/state-machines.json).
- [NewUI integration manifest](contracts/v1/ui-foundation.json) records the reviewed source revision, observed package versions, permitted entrypoints and route compositions; product installation remains a validation gate.
- [Architecture model](contracts/v1/architecture.json), [Brain configuration](examples/v1/config/brainconfig.yaml), [web build profile](examples/v1/config/web-build.json) and [Vite/CSS references](examples/v1/web/README.md) align the three planes, NewUI dependency boundary and immutable image assets.
- [Configuration and transport examples](examples/v1/manifest.json), [reference global SQL](sql/reference/control.sql), [reference workspace SQL](sql/reference/workspace.sql).
- [Verification script](scripts/verify_implementation_pack.py), [pack builder](scripts/build_implementation_pack.py), and [verification evidence](artifacts/implementation/verification.json).
- [OpenCode project profile](opencode.json), [execution plan](contracts/v1/execution-plan.json), [dependency baseline](contracts/v1/dependency-baseline.json), [authorization matrix](contracts/v1/authorization-matrix.json), [task packets](contracts/v1/task-packets.json), [scenario catalog](contracts/v1/scenario-catalog.json), [literal oracles](contracts/v1/acceptance-oracles.json), [screen bindings](contracts/v1/ui-screen-contracts.json) and [readiness status](contracts/v1/readiness.json).
- [Closed golden release](examples/v1/golden-release/manifest.json) and [sanitized execution environment](artifacts/implementation/execution-environment.json). Package resolution, native OpenCode loading and actual model/runtime qualification remain separately visible; pack coherence does not certify them.
- [Canonical work plan](contracts/v1/work-plan.json) generates task tables/packets and scenario ownership. [Screen contracts](contracts/v1/ui-screen-contracts.json) generate the route index and define five navigation areas. Run `rtk python3 scripts/generate_implementation_indexes.py --check` for freshness. Current readiness derives from [runtime evidence](artifacts/implementation/runtime-readiness.json); requirements and historical fixtures remain separate.

After changing canonical inputs, run `rtk python3 scripts/generate_implementation_indexes.py` and `rtk python3 scripts/generate_contract_types.py`, then `rtk python3 scripts/verify_implementation_pack.py` and `rtk python3 scripts/build_implementation_pack.py`. The checker requires PyYAML/jsonschema and records their versions. It also runs the reference approval controller and policy/evidence fixtures. These checks validate the pack; real vendor/browser/kernel/performance proof remains in runtime evidence. SQL is fresh current-schema setup; historical upgrade/data migration work is excluded.

Specification precedence: current user instructions and implementation policy govern process/scope; machine schemas define wire shape; state machines define legal transitions; these documents define semantics and authorization. Resolve target inconsistencies by updating affected artifacts together. Original inputs remain unchanged for provenance and cannot reintroduce waived requirements. Do not implement both old and new grammars.
