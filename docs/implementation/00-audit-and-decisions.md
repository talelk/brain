# 00 — Audit, decisions and unresolved validation

## Scope and evidence

The supplied inputs are the 59,667-byte v4 RFC, the 14,853-byte runner amendment, the 23-entry contract ZIP and the 54-page French presentation. Their hashes are in `contracts/v1/source-inputs.json`. The presentation describes an earlier product and reports historical measurements. Those numbers are not benchmarks of this design. The ZIP is a starter: no `EvidenceBundle` DTO, complete runner protocol, typed command registry or executable lease transaction was provided.

Official documentation was consulted on 27 October 2026, including Context7 for Mastra, Better Auth and Pi and official documentation/repositories for the remaining selected components. [13-library-reference.md](13-library-reference.md) records the evidence and adoption disposition. Documentation review is distinct from a pinned, installed integration test. No vendor service was deployed during preparation.

## Corrections adopted by this pack

| ID | Problem in the inputs | Decision |
|---|---|---|
| D01 | `spec.nodes`, root `jobs`, and different primitive names conflict | Canonical authoring is `spec.jobs`, keyed by ID, with six `kind` values and `needs`. `dispatch.uses` selects an agent or tool. No compatibility parser. |
| D02 | Runner state conflates health, drain and resource use | Store administrative state, connectivity and allocation separately; derive display status. Busy can coexist with draining. |
| D03 | Same-file Mastra/Brain storage was preferred before proof | Use `workspace.mastra.db` by default. One Governor process owns Mastra access. Shared-file optimization is deferred. |
| D04 | Global leases and workspace history look atomic | Only `control.db` authorizes. Durable commands/events cross files. Workspace projections explicitly expose lag. |
| D05 | Offer, claim, approval consumption and effect start blur together | Reserve capacity on offer; ACK starts execution; consume approval only at a separate effect permit transaction. Failed delivery must not consume approval. |
| D06 | Fences may be mistaken for external write protection | Each resource has its own durable counter. A stale result is rejected, but external targets require CAS/preconditions or scoped revocable credentials. Unsupported targets require conservative reconciliation. |
| D07 | Unknown outcomes may be retried as generic errors | Unknown effect outcomes remain blocked until target-specific reconciliation. Never route them through general retry helpers. |
| D08 | YAML security floor merge is underspecified | Typed restrictive intersection, explicit inheritance, fixed merge rules and provenance. Unknown fields, duplicate keys and custom tags fail. |
| D09 | Organization/team/workspace scope is ambiguous | Organization is the tenant boundary. Every workspace belongs to one organization. Global memory means organization-global approved content. Cross-organization sharing requires a separate reviewed export/import. |
| D10 | “Independent evaluator” lacks an authority model | Evaluators execute in separate attempts with pinned evaluator code and input artifacts; authoring harness cannot issue verdicts or change test fixtures. |
| D11 | Suspended approval may retain a runner/worktree lock | Release compute and logical effect locks. Preserve immutable artifacts/checkpoints. Reacquire admission and validate preconditions after approval. |
| D12 | PWA may imply native background guarantees | PWA supports responsive interaction and best-effort push. No guaranteed periodic background scans, Android keystore parity or native widgets in V1. |
| D13 | Runtime dependency versions appear frozen from prose | Keep one coherent target contract set; change related contracts/callers/tests together when necessary. Record exact selected dependencies, images, SQLite engine builds and smoke evidence. |
| D14 | “All edge cases” has no finite acceptance boundary | Maintain an explicit scenario and fault inventory. Unknown failures fail closed for effects and produce a diagnosable blocked state. No claim of exhaustive future-failure coverage. |
| D15 | Initial UI proposal duplicated primitives, tokens and shell behavior already supplied by the user's chosen library; the config omitted this choice | NewUI is the required UI foundation, explicit in UIConfig/WebBuildConfig and ArchitectureModel. Public packages/tokens/templates bind at image build; Git presentation defaults reference the shipped manifest digest. Brain owns domain compositions and Governor adapters. The reviewed atomic package API supersedes historical `@newui/ui` examples. |
| D16 | Earlier process text required isolated increments, historical migrations and cross-version retention | The user waives compatibility, migration and incremental-change constraints until explicit new instruction. Build the target directly; breaking/coordinated changes are allowed. Fresh schema setup, selected-dependency integration and same-version recovery remain required. |
| D17 | A smaller coding model still had to choose integrations, invent authorization tables and recover context informally | Documents 17–22 select target decisions, define exact OpenCode model/instructions, typed execution records, expanded authority SQL, screen queries, literal oracles and a closed golden release. Live dependency/model/vendor proofs remain explicit gates. |

These are engineering decisions for the requested implementation proposal, not changes to a running deployment.

The [implementation policy](../../contracts/v1/implementation-policy.json) and [implementation prompt](../../IMPLEMENTATION_PROMPT.md) carry D16. Older source requirements cannot reintroduce waived work. Dependency integration gates test the chosen runtime; they do not require support for previous Brain versions.

## Release gates

| Gate | Required experiment | Pass evidence | Fallback / blocked scope |
|---|---|---|---|
| G01 Dependency baseline | Install exact Node LTS, TS, Hono, auth, driver, schema, NewUI package set and test packages on Linux amd64; arm64 before advertising support | lockfile, SBOM, license report, native-driver smoke; NewUI exports, CSS/theme, Solid peers and production bundle smoke | Platform support stays unadvertised; UI integration blocked until selected artifacts pass |
| G02 SQLite engine | Inspect `sqlite_version()` and compile options for better-sqlite3, libSQL and TencentDB separately | Patched WAL implementation and required FTS5 capability | Reject unsafe build or vendor-documented fixed equivalent |
| G03 Mastra | Compile all six primitives, suspend asynchronously, restart, early wake, duplicate wake, failed persistence, cancellation | 100 suspended runs; no duplicate jobs/effects; bounded storage | Workflow feature blocked; contract unchanged |
| G04 TencentDB | Two organizations, two workspaces, users/agents/teams, revocation, search, Wiki/CodeGraph, export/restore | Negative ACL tests and measured service footprint | Memory optional/degraded; dedicated deployment for stricter tenants; no private code indexing without proof |
| G05 Harness | Pi and Claude start/event/cancel; feature-by-feature resume/steer/intercept | Same synthetic task and denied bypass in both sandboxes | Unsupported features explicitly disabled |
| G06 Sandbox | Hostile child process, fork bomb, filesystem escape, blocked network, daemon escape, secret remnants | Kernel-enforced denial and cleanup receipts | Privileged operations disabled; disposable VM for hostile workloads |
| G07 Restore | Restore global backup and workspace-only import into clean host, including suspended workflow | Hash verification, old tokens invalid, unknown external effects blocked | No “portable complete backup” claim |
| G08 Performance | Defined workload at fixed resources, fault injection, at least three comparable runs | Raw results, percentiles, memory/CPU/WAL sizes | Admission limits reduced; no unmeasured scale claims |

SQLite's official WAL documentation describes a corruption race fixed in 3.51.3 and later, with specified older backports. Verify the embedded SQLite engine, not just the npm package version. A libSQL fork needs evidence of an equivalent fix. [SQLite WAL](https://www.sqlite.org/wal.html)

Mastra labels dynamic workflows beta and warns that they can change incompatibly without a major version change. Its production storage guidance excludes local-file multi-process deployment. Brain's constrained single-owner profile needs G03; a separate file alone does not prove durability. [Dynamic workflows](https://mastra.ai/docs/workflows/dynamic-workflows), [storage guidance](https://mastra.ai/docs/storage)

## Bounded initial product

V1 runs one active Governor on local Linux SSD storage, multiple outbound runners and optional memory services. No active-active Governor, network-mounted WAL, distributed database locks, arbitrary inline workflow scripts, automatic privileged repair, public memory endpoints or cross-tenant cache. No mandatory Redis/Postgres/Kubernetes. These exclusions keep the implementation testable while adapters preserve future extension.

All production writes require exact human approval. Nonproduction writes may use Git-declared policies. Emergency stop/revocation is operational state and takes precedence over pinned configuration. It can narrow permissions immediately; widening requires a new reviewed Git release.

Resource targets are proposed in document 10. Feature-specific service footprint, physical isolation and data retention must be selected for the deployment. The default assumes one customer organization, while schema and authorization always preserve organization isolation.

## Canonical editing map

| Decision/data | Single editable authority | Derived views |
|---|---|---|
| Wire DTOs | brain.schema.json | brain.generated.ts |
| Command capability and actor kinds | registry.json | Handler catalog/checks |
| Role capabilities and query/endpoint rules | authorization-matrix.json | Role summaries/allow-deny tests |
| Executable/module layout | module-layout.json | Document 01 table |
| Work coverage/files/check commands | work-plan.json | Document 12 table and task-packets.json |
| Acceptance trigger/observation | Document 11 scenario table; acceptance-oracles.json for literal traces | scenario-catalog.json and focused context output |
| UI routes/navigation/actions | ui-screen-contracts.json | Document 09 route index |
| Runtime/model execution state | Trusted VerificationRun artifacts | runtime-readiness.json and verification report |

Edit an authority once and regenerate its derived artifacts. Narrative documents explain semantics and tradeoffs, without repeating mutable implementation status. Source-review manifests and initial examples retain their historical meaning. The control plane remains a modular monolith; these records do not create more services.
