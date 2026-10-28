# 18 — Closed implementation decisions and reproducible bootstrap

## Decisions the implementing model must not reopen casually

| Concern | Target decision | Exact implementation consequence |
|---|---|---|
| Runtime | Node 24 LTS, Linux amd64, glibc; ESM TypeScript | One current runtime image; arm64 is unadvertised until its native and isolation tests pass |
| Database | better-sqlite3 for Brain; Drizzle schema/repositories; separate Mastra libSQL file | No shared Brain/Mastra file experiment on the required path; no network call in a transaction |
| Human auth | Better Auth email/password + organization + twoFactor TOTP | Public self-signup disabled after local bootstrap; initial vendor schema generated from this exact plugin set |
| Step-up | Fresh TOTP verification bound to current session and approval subject | Five-minute, single-subject server-side evidence; trusted-device cookies and recovery-code login do not satisfy effect step-up |
| Canonical JSON | npm `canonicalize`, RFC 8785 | Validate bounded JSON, duplicate keys and lone surrogates before canonicalizing; run RFC vectors, then SHA-256 UTF-8 bytes |
| Effects | Opaque 256-bit random online permits | HMAC-SHA-256 token lookup with server-held pepper; no JWT/offline verification path; 15-second permit validity |
| Runner identity | Ed25519 SPKI PEM public key plus one-use enrollment and opaque sessions | Private key remains on runner; challenge-signature proof at hello; token families rotate and revoke by epoch |
| Pi | Native SDK inside controlled isolated child | Explicit tools/resources/home; no ambient plugin discovery; normalize at runner boundary |
| Claude | TypeScript `@anthropic-ai/claude-agent-sdk` inside isolated child | Use SDK query/permission hooks, supported application credentials and supervised process termination; no second CLI integration |
| ACP | Optional, disabled until stable-v1 conformance passes | No runtime requirement for experimental protocol-v2 APIs |
| Launcher | Brain-owned constrained Unix HTTP service over rootless Docker Engine | Separate trusted service account; typed create/inspect/stop; supervisor cannot issue arbitrary Docker payloads |
| Egress | Isolated internal job network; dedicated allowlist proxy; no direct external route | Proxy resolves/validates destinations and redirects; deny metadata, private ranges unless profile explicitly permits them; do not treat bridge networking as an allowlist |
| Privileged jobs | Separate host trust domain and fixed tool images | Never schedule general agent tasks in privileged slots; approval does not bypass this rule |
| Remote reference connector | GitLab REST API v4 issues/notes, direct bounded HTTP | Complete fixture adapter for local tests; real server URL/credential are operator inputs; no client-specific constants in core |
| UI | NewUI public atomic packages, one Solid SPA served by Governor | AppShell/PaneLayout/AuthLayout; exact-source recipes and UI oracles; no extra UI backend |
| TencentDB | Scoped private service behind MemoryGateway | Required memory capability remains blocked until G04; core startup may expose explicit degraded memory when config allows it |
| Workflow engine | Mastra dynamic graph behind canonical Brain IR | All six primitives and durable waits must pass G03; if pinned API cannot express them, block that feature and report reproduction; do not invent a second engine |

These decisions select target integrations; they do not certify vendor behavior. The machine record is [execution-plan.json](../../contracts/v1/execution-plan.json). Optional/deferred scope in document 15 remains optional/deferred. The implementation policy still excludes compatibility, historical migration and incremental delivery constraints.

## Dependency freeze algorithm

[dependency-baseline.json](../../contracts/v1/dependency-baseline.json) separates selected exact candidates, unresolved artifact resolution, optional dependencies and non-package standards. A library documentation register is not a lockfile. `exactProductVersion:null` is legitimate for an uninstalled adapter, but cannot pass G01.

Run `rtk python3 scripts/resolve_dependency_baseline.py` on a network-enabled host. The resolver fetches only official Node/registry metadata, writes exact Node 24 LTS distribution SHA-256 and package candidate versions/integrity to `artifacts/implementation/dependency-resolution.json`, and never executes downloaded package scripts. Required NewUI versions come from the reviewed source manifest. Remaining required packages resolve the registry's stable `latest` once into a snapshot; this is candidate discovery, not a coherent installed baseline. Use the candidate snapshot as input to strict peer/engine installation, correct incompatible exact selections from primary package evidence, and retain one tested final cohort. Never install floating `latest` at runtime. Resolution fails as a whole on a missing artifact. Verify Node's signed release checksums and artifact bytes before execution. Review prereleases, engines, peer ranges, repository lineage, licenses and integrity before package installation; incompatible candidates remain failed, never silently forced with peer-dependency flags.

Create manifests for the five executable roots and the single shared contracts package in `module-layout.json`. Internal Governor modules are folders, not package manifests. Use `examples/v1/pnpm-workspace.yaml`: strict peer checks, strict engines and exact saving. Generate one lock, verify the entire selected cohort (native/auth imports and production NewUI build included), then prove a frozen clean install. Missing peers or engine failures must fail rather than be silenced with override flags. [pnpm settings](https://pnpm.io/settings), [frozen install](https://pnpm.io/cli/install) Record actual Node/pnpm versions, lock SHA, package integrity, engine versions, native build result, license inventory, SBOM and exact source revision/fingerprint in the G01 evidence. Native build scripts are allowlisted by need; do not globally enable arbitrary lifecycle scripts. Vendor initial schema generation is required current-schema setup, not historical migration work.

The pack's environment cannot currently resolve `registry.npmjs.org` from the shell. A few official metadata records and source observations are recorded as candidates; they are not a tested working dependency set. No fake product lockfile, fabricated integrity or invented version closes this limitation. The resolver, failure state and test recipe make the missing execution step explicit and repeatable.

## Exact gate ownership and outputs

| Gate | Implementing files | Required artifact directory and assertions |
|---|---|---|
| G01 | `tests/probes/dependencies/`, manifests/lock, NewUI recipe compile | `artifacts/runtime/G01/`: frozen install, actual exports, production CSS, native auth/SQL smoke, SBOM; all required imports work |
| G02 | `apps/governor/src/infrastructure/persistence/open.ts`, engine-health probe | `G02/`: each SQLite `sqlite_version()`, compile flags, FTS5 where needed, WAL stress; accept 3.51.3+ or explicitly documented vendor-fixed engine after checking upstream advisory |
| G03 | `tests/probes/mastra/`, lowering/wake bridge | `G03/`: six primitive graph, 100 waits, early/duplicate wakes, restart/cancel/write failure; count jobs by execution key, zero duplicate effects |
| G04 | `tests/probes/tencentdb/`, gateway scope/export | `G04/`: exact source/image/HTTP schema, tenant canaries for every asset API, revocation, memory/Wiki/CodeGraph export inventory and measured footprint |
| G05 | `tests/probes/harnesses/`, Pi/Claude conformance | `G05/`: versioned capability matrix, denied bypass, event/cancel/checkpoint evidence; real provider smoke separate from deterministic adapters |
| G06 | `tests/probes/sandbox/`, launcher/egress | `G06/`: cgroups v2 limits, daemon kill, filesystem and network denied paths, cleanup; fail closed before sensitive scheduling |
| G07 | `tests/chaos/restore.test.ts` | `G07/`: restored hashes, waits and state; restored identities/approvals cannot execute until fresh authority; include missing-memory inventory |
| G08 | `benchmarks/`, profile runner | `G08/`: fixed profile, three measured runs, raw samples and p50/p95/p99/RSS/WAL/event-loop data; never extrapolate an unmeasured host |

Use one `VerificationRun` manifest per gate at the paths in `execution-plan.json`; it contains the current product/lock digests, command argv/exit/duration, required assertion IDs, selected/executed/skipped cases and raw artifact paths/hashes. Test runners produce records. `scripts/verify_runtime_evidence.py` validates current records and derives readiness; it does not execute the recorded commands or independently certify their authorship. A forged manifest cannot substitute for trusted runner output and independent release review. Historical source-review flags and example ledgers are separate from live evidence. Missing credentials mean `blocked`, missing implementation means `not-run`; neither passes. A documentation record cannot turn a runtime gate green.

## Fresh system bootstrap and host contract

Supported baseline host: Linux with cgroups v2, user namespaces, rootless Docker, a local persistent filesystem supporting SQLite WAL locks, TLS termination, synchronized wall time and enough reserved disk. Governor and trusted launcher are different service accounts; privileged runners use a different host. SQLite WAL files do not live on network filesystem mounts. Start with the resource limits in document 10; reduce admission on actual measurements.

Product commands include `brain setup --local --email <email> --name <name> --org <id> --setup-token-file <private-file>`, `brain login`, `brain logout`, `brain doctor` and `brain runner token create --group <id>`. Governor writes a one-use host credential to its private `setup.token` file; it never prints the secret into service logs. Setup authenticates that credential, creates the actual Better Auth account/organization, records explicit Brain roles, consumes setup authority and removes the file. A pending setup resumes only for the same organization/email with valid account credentials; an existing or restored installation never reopens bootstrap. The CLI saves its native session privately and prints no sign-in token. Doc 24 records the implemented protocol.

`brain config compile <root>`, `brain config activate <digest>`, full runner enrollment/management and complete remote backup/export commands remain required where not implemented. Current trusted host maintenance uses `pnpm --filter @brain/governor maintenance <backup|verify|restore>` and produces explicitly partial local archives (doc 10). Do not present these as complete remote workspace exports. Enrollment never edits Git policy. Import/restore accepts the current format only and refuses non-empty destinations.

Images must contain the actual compiled entrypoints, immutable web assets, manifest, current SQL and health command. Startup validates environment, artifact digests, schema identity and single-Governor lock before accepting mutations. Liveness means the process responds; readiness means authority storage, config and required services are usable. Memory-only outage may degrade if configured; unavailable authorization never degrades to allow. SIGTERM stops admission, persists work, cancels timers and closes databases within 30 seconds; unconfirmed external effects stay guarded.

No `.git` initialization/reset is assumed in this documentation workspace. Product setup needs a real writable source/config checkout; report the environment requirement if the host supplies a read-only placeholder. Do not delete that placeholder or user data to make a probe pass.

## Official decision references

Use the pinned package's own typings together with these primary references: [Better Auth twoFactor](https://better-auth.com/docs/plugins/2fa), [auth hooks](https://better-auth.com/docs/concepts/hooks), [canonicalize](https://github.com/erdtman/canonicalize), [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), [Claude SDK](https://platform.claude.com/docs/en/agent-sdk/overview), [Docker Engine API](https://docs.docker.com/reference/api/engine/), [GitLab issues](https://docs.gitlab.com/api/issues/), [notes](https://docs.gitlab.com/api/notes/). Do not copy guessed method signatures from prose into vendor adapters.
