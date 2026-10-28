# 03 — Configuration compiler and workflow execution

## Canonical documents

All definitions use `apiVersion: brain.keyrus/v1`, a `kind`, immutable logical metadata and a typed `spec`. Supported kinds are BrainConfig, WorkspaceType, Workspace, RunnerGroup, Agent, Tool, Policy, Workflow, Pack, Connector, Evaluator and Schedule. Operational registry bindings, credentials and observed inventory are not declarations. `TOOL.md` and agent Markdown embed the same validated metadata in frontmatter; their instruction body is included in the release digest.

The machine schemas cover executable baseline configuration; kinds introduced by later tasks must receive schema, fixtures and semantic validation before activation. No undefined kind is accepted just because this document names it. Extensions are deferred in V1 to keep unknown-field rejection meaningful.

## Safe loader

Load only a clean, read-only checkout of a reviewed commit from an allowlisted repository. Resolve every referenced relative path inside that checkout after realpath confinement. Reject symlinks escaping the root, submodules without pinned approved contents, absolute paths, NUL, traversal, case-colliding logical IDs, duplicate keys, YAML aliases/merge keys, custom tags and multiple YAML documents. Limit each definition to 256 KiB, the release to 20 MiB excluding packaged tool bytes, and the workflow to 100 jobs. Binary/tool assets have separate quotas and hashes.

Use the `yaml` document API for source positions, then reject parse diagnostics and aliases before conversion. Strings such as capability labels containing colons are explicitly quoted in examples. YAML dates remain strings under the restricted schema. No environment interpolation except typed secret **references**, resolved only at runtime by the broker. A `${...}` string does not execute or read the process environment.

## Resolution and policy floor

Apply `security floor → organization defaults → workspace type → workspace → permitted request override`. Keep one parent workspace type in V1; reject inheritance cycles. Merge named resources by ID with explicit tombstones for optional resources; anonymous arrays replace. Required floor resources cannot be removed. A null value is a value only where schema permits it, never a generic deletion instruction.

Security resolution is typed: allowlists intersect, deny lists union, booleans requiring a safeguard OR together, numeric upper limits take minimum, required minimum isolation/risk constraints take the stricter order. Unknown/incomparable settings fail rather than choosing an arbitrary maximum. Apply defaults before comparing. An override cannot add a target, broaden a runner group or turn off production approval. Record origin file, line and inherited value for every effective field. `config explain /path` displays the complete resolution chain and final reason.

## UI configuration and immutable build binding

`BrainConfig.spec.ui` is required in the current target contract. Its `UIConfig` shape contains `foundation: newui`, `foundationManifestDigest`, `defaultTheme`, `density`, `supportedLocales`, `defaultLocale` and `enabledChannels`. The canonical example is [brainconfig.yaml](../../examples/v1/config/brainconfig.yaml). Replace earlier declarations with this target shape; do not write converters or a compatibility parser. The user's direct-target policy permits coordinated breaking changes before implementation completion.

Presentation defaults are Git declarations. Per-user/device theme or language preference may select an already-supported value; it cannot change the library, token authority, target permissions or enabled product capabilities. `compact` maps to NewUI's default `sm` (28 px), `comfortable` to `md` (32 px); these are controlled recipe choices, not arbitrary CSS. Unknown UI fields, custom palette objects and arbitrary library names fail schema validation. The default locale must be included in supported locales.

The authenticated `workspace.context` query projects these resolved values as `WorkspaceContext.ui`; clients do not read the config repository or operational DB directly. Until that context is authorized/available, sign-in and the public shell use bundled safe presentation defaults. Feature availability is returned separately so a requested PWA/TV channel cannot appear implemented merely because configuration names it.

`foundationManifestDigest` is the SHA-256 **byte digest** of the exact UI foundation manifest supplied as a release asset and built into the Governor image. Do not conflate this CAS byte hash with canonical object hashing for config/action subjects. The compiler includes that manifest in the release asset closure, rejects a mismatch with the supported build manifest, and emits stable diagnostics such as `UI_FOUNDATION_MISMATCH` or `UI_DEFAULT_LOCALE_UNAVAILABLE` within its typed compilation result. No operational database row overrides this declaration.

The separate [web build profile](../../examples/v1/config/web-build.json), typed as `WebBuildConfig`, describes image-build package candidates, the reviewed source commit, semantic CSS, static asset paths and permitted dev proxy prefixes. It is a source/build contract, not a runtime workspace definition or a substitute for a lockfile. G01/T33 resolve and verify actual package artifacts and produce a promoted build manifest. Runtime YAML never downloads npm packages, mounts a developer checkout or switches to a different frontend. Changing foundation bytes requires a corresponding verified image/config release and expected-version activation.

Config activation/readiness compares the declared byte digest with the shipped `/app/ui/ui-foundation.json`, and verifies requested UI channels against the built feature registry. The reference declaration enables `web` only. PWA/TV can be requested only when their implementation/authorization gates pass; a Git boolean does not implement them or grant kiosk mutation permission. A schema-valid source-review candidate is not production-ready merely because its hash matches. The current pack validates reference consistency; G01/T33/T48 still provide executable activation/readiness enforcement.

## Single workflow grammar

Canonical shape is `spec.jobs.<jobId>` with `kind` and `needs`. Earlier `spec.nodes`, root-level `jobs` and string `uses: brain.agent-task` are rejected as unsupported declarations. The pack examples use only the target shape. Do not implement a converter, alternate parser or dual grammar.

| Kind | Required meaning | Runner usage |
|---|---|---|
| `dispatch` | `uses.type: agent|tool` and a version-pinned registry reference | Requires `runsOn`; creates durable job |
| `gate` | Exact operation proposal plus approval policy and binding | No runner; durable wait |
| `eval` | Pinned evaluator and acceptance inputs | Separate evaluator job and group |
| `steer` | Message to an identified running session | Control operation; requires live authorized session and negotiated feature |
| `merge` | Exact repository/base/head and verified evidence | Pinned privileged tool, serialized merge resource |
| `subgraph` | Pinned nested workflow reference and input bindings | No retained parent slot; children schedule independently |

`runsOn` has group, all capabilities, optional anyOf alternatives, numeric resources, isolation and engine requirements. User-facing CPU is integer millicores in this pack; no mixed `cpu: 2` conversion. The same `Placement` DTO is used by the scheduler. An agent job has explicit engine alternatives and features; `anyOf` labels alone do not establish an engine ABI.

Inputs and workflow outputs are maps of binding names to discriminated bindings: literal JSON value, workflow input JSON Pointer, or predecessor job output JSON Pointer. Pointers use RFC 6901 escaping; missing path is an error, never empty string/null substitution. A job may reference only declared transitive predecessors. No arbitrary expression language, JavaScript, shell substitution, network schema references or implicit access to credentials.

Every job declares an output schema reference from the immutable release. Schema resources use the Brain-supported JSON Schema subset: primitive types, objects with fixed properties, arrays with one item schema, enum/const, required, bounds and local references. General schema implication is undecidable/practically complex; reject unresolved binding compatibility instead of claiming complete static type checking. Runtime validates all actual outputs regardless of compile-time checks. Untrusted schemas have complexity/regex limits and no network `$ref` loading.

## Graph semantics

Jobs without dependencies are ready in lexicographic ID order; scheduling can execute independent jobs concurrently. `needs` is an AND join. Success includes an evaluator's explicitly accepted result, never model text. Failed, cancelled, rejected or unknown predecessor causes descendants to become `skipped` with a reason; unrelated already-running branches may finish according to workflow fail-fast setting. Default fail-fast stops new dispatches and requests cancellation of active branches; collected evidence remains accessible.

Graph must be acyclic; duplicate IDs, unknown dependencies, unreachable output references, gate without exact proposal and effects lacking required gate ancestry fail compilation. A gate dominating an effect is necessary but insufficient: runtime still binds the exact action digest. A new action payload after approval creates a new gate request. No implicit “approved workflow” permission applies to later tools.

Retries are declared by class and bounded count. Read-only transient work defaults to at most two retries with backoff; validation/policy/unsupported-capability failures never retry automatically. Effects default to zero retries. A connector can permit retry after an authoritative target read proves absence and its idempotency/precondition contract passes. Compiler-level `converge` loops are deferred; V1 workflows remain DAGs. A bounded repair is expressed as explicit jobs/subgraphs with finite dependencies, not runtime code generation.

Timeouts: queue deadline, attempt runtime and approval expiry are separate clocks. Human wait does not consume runner runtime. A workflow has an absolute retention/deadline limit, default seven days for the baseline, extendable by policy. Cron misfire behavior is declared separately; no infinite catch-up burst.

## Compilation pipeline and IR

1. Capture source commit, compiler version, schema version and registry manifests.
2. Parse and validate shapes; retain source maps.
3. Resolve inheritance and restrictive security rules.
4. Resolve every reference to a full release digest; reject moving tags at activation.
5. Build dependency closure, topological order and binding/type diagnostics.
6. Classify effects, gate ancestry and evaluator independence.
7. Produce immutable IR containing normalized jobs, bindings, placement, limits, primitive versions, schemas and provenance.
8. Hash canonical IR plus the complete referenced asset manifest. Exclude volatile activation timestamps from the digest.
9. Lower IR through the selected workflow adapter. Store graph output digest as a derived artifact, not contract authority.
10. Dry-run trusted fixture primitives and persist an immutable config release. Activation uses expected previous release version and audit/outbox in one global transaction.

Diagnostics include stable code, severity, source file, line/column, JSON pointer and one concrete correction. Failed compilation leaves the active release unchanged. Dry-run never invokes an effect or issues a real approval. Graph registration occurs under the full digest-derived key; no mutable upstream workflow ID is reused for another release.

## Mastra bridge

Register only trusted Brain primitive wrappers. Each wrapper invokes an application port with `(runId, jobId, executionKey)`; the application service deduplicates execution. Dynamic graphs reference those registered wrappers. Actual support for durable asynchronous primitives must be demonstrated by G03: do not assume a registered tool automatically exposes every suspend/resume operation available to a code-defined step.

If dynamic graph lowering cannot represent a durable wait safely on the pinned version, stop that task and implement an adapter-local trusted nested workflow using documented APIs, or keep the workflow feature blocked. Neither option changes the YAML/IR or allows an invented SDK call. No second workflow authority is added as a convenience.

`WorkflowEnginePort.start` persists a start intent before calling Mastra. The engine run ID is deterministic from Brain run ID. A dispatched step records its job ID before returning/suspending. Resume is keyed by wake event ID and wait generation. A wake worker reads durable pending wakes, inspects engine state, resumes only the exact wait and records acknowledgment. Approval-before-snapshot is repaired by retrying the wake intent after the snapshot becomes resumable. Duplicate wake becomes a no-op; old wait generation cannot wake a later gate.

Run outcome derives from required business steps and verified evidence. Mastra's `success`/other vendor statuses are mapped inside the adapter; product statuses do not copy vendor strings. A run may be blocked while required current-build state is absent or invalid. Preserve pinned current-build definitions/config/artifacts and snapshot backups for same-version suspended-run recovery. Do not retain historical executable implementations or build cross-version converters.

Schedules belong to Governor: unique `(scheduleId, releaseDigest, scheduledAt)` fire records, explicit IANA timezone, DST policy, maximum catch-up and concurrency mode. Mastra is not also allowed to independently schedule the same job. Default misfire is coalesce-to-one, overlap is skip-with-reason and house scans have a persistent next-run cursor.

## Bounded configuration surface

Keep the six workflow kinds and existing JSON Pointer/literal bindings. Policies select typed facts and named operations; sandbox configuration selects one of three preinstalled process profiles. Do not add arbitrary expressions, inline execution, runtime JavaScript plugins, a network-policy DSL or a second graph engine. Extending compiled pack code uses ordinary module folders and an explicit contract/test change. This preserves the full feature set without building another programming language.
