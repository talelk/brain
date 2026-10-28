# 13 — Library documentation review and adoption register

Reviewed 27 October 2026. Links below are primary sources consulted through official documentation, official repositories or Context7 indexes of those sources. `Review` means documentation capability/limitations were inspected. It does **not** mean the npm package was installed, licensed for every deployment, benchmarked, vulnerability-certified or tested against the other packages. Exact versions and compatibility results remain G01–G08 deliverables. Do not replace missing pins with `latest` in production.

The original architecture lists both required and optional tools. This register covers both and states whether they should actually be adopted. A short dependency list improves startup, maintenance and smaller-model implementation reliability.

## Core runtime and persistence

| Component | Official evidence | Adoption and implementation rule |
|---|---|---|
| Node.js | [Release support](https://nodejs.org/en/about/previous-releases) | Select supported LTS; Node 24 is the candidate line at review time. Pin patch/image and verify native modules. |
| TypeScript | [TSConfig reference](https://www.typescriptlang.org/tsconfig/) | Strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes; Node/SDK major compatibility in G01. The local pack checker currently uses available TS 5.9.3; this is not the product pin. |
| pnpm | [Install and lockfile behavior](https://pnpm.io/cli/install) | One workspace/lockfile, exact packageManager, frozen CI installs, reviewed build-script allowlist. Documentation must be refreshed in G01 for selected pnpm major. |
| Hono | [Node deployment](https://hono.dev/docs/getting-started/nodejs), [streaming](https://hono.dev/docs/helpers/streaming) | Thin HTTP adapter; explicit body limits, abort cleanup and SSE backpressure. Do not copy an old major's adapter signatures. |
| Better Auth | [Hono](https://better-auth.com/docs/integrations/hono), [organization](https://better-auth.com/docs/plugins/organization), [installation](https://better-auth.com/docs/installation) | Identity/organization integration; Governor retains operation policy and exact approval ledger. Generate plugin schema from pinned config. |
| Better Auth API keys | [API key reference](https://better-auth.com/docs/plugins/api-key/reference) | Optional for approved machine/delegated identities; runner enrollment/session semantics remain Brain-owned. Confirm scoped verification/revocation before adopting. |
| Drizzle ORM / Kit | [SQLite drivers](https://orm.drizzle.team/docs/sqlite/get-started-sqlite), [transactions](https://orm.drizzle.team/docs/transactions) | Use documented better-sqlite3 driver and reviewed current-schema initialization; no historical migration framework or async work inside synchronous transactions. Never overwrite non-disposable state through schema-push. |
| better-sqlite3 | [Driver API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) | Brain's candidate local driver; inspect embedded engine and bounded blocking latency. Direct driver docs need pinned-version recheck at G01. |
| SQLite | [WAL](https://www.sqlite.org/wal.html), [backup](https://www.sqlite.org/backup.html), [ATTACH atomicity](https://www.sqlite.org/lang_attach.html) | Local-file, one-owner authority; fixed engine build, short transactions, online backup and cross-file reconciliation. |

## Configuration and workflow

| Component | Official evidence | Adoption and implementation rule |
|---|---|---|
| `yaml` | [Document/parser API](https://eemeli.org/yaml/) | Candidate 2.x API family; reject aliases/custom tags/duplicates and preserve source positions. |
| JSON Schema | [Specification](https://json-schema.org/specification) | Draft 2020-12 wire authority with restricted executable-config subset. |
| Ajv | [Schema language](https://ajv.js.org/guide/schema-language), [strict mode](https://ajv.js.org/strict-mode.html) | Use 2020-12 entrypoint, strict compilation, no coercion/default mutation/removal of unknown fields, no network refs. Compile once per digest. |
| Zod | [JSON Schema conversion](https://zod.dev/json-schema) | Adapter-local where SDK requires it; v4 candidate. No second handwritten canonical contract and no unsupported transforms as wire types. |
| Mastra core | [Dynamic workflows](https://mastra.ai/docs/workflows/dynamic-workflows), [announcement](https://mastra.ai/blog/introducing-dynamic-workflows) | Beta integration behind IR/port. Exact package pin required even across minor/patch updates. No direct user administration endpoints. |
| `@mastra/libsql` | [Storage](https://mastra.ai/docs/storage) | Private per-workspace engine file, single-owner constrained profile, restart/durability probe. Multi-process production is outside baseline. |
| `cron-parser` | [Project README](https://github.com/harrisiirak/cron-parser) | Parse schedule and timezone; Governor persists fires/misfires/overlap. Test DST boundaries rather than using a process timer as truth. |
| RFC 8785 canonical JSON | [IETF standard](https://www.rfc-editor.org/rfc/rfc8785), [canonicalize](https://github.com/erdtman/canonicalize) | Select npm canonicalize; strict duplicate/surrogate/number validation and literal vectors. Exact installed artifact must pass G01. |
| OpenSpec | [Official project](https://github.com/Fission-AI/OpenSpec) | Optional change-file convention; not a runtime engine or authorization system. No mandatory CLI dependency. |
| XState / OMA | Not adopted | No parallel workflow authority; fallback engine would require a new adapter gate, not dual execution. No API recommendation is made here. |

## Harnesses and process control

| Component | Official evidence | Adoption and implementation rule |
|---|---|---|
| Pi | [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) | Isolated child with explicit resources/tools. Current and historical npm scopes differ; pin and verify lineage instead of mixing examples. |
| Claude Agent SDK / CLI | [Overview](https://code.claude.com/docs/en/agent-sdk/overview), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [headless CLI](https://code.claude.com/docs/en/headless) | Separate native adapter; confirm authentication/product terms, permission behavior and process-tree stop. No bypass-permissions production profile. |
| ACP TypeScript SDK | [Official README](https://github.com/agentclientprotocol/typescript-sdk) | Default stable protocol-v1 entrypoint; v2 entrypoints experimental. SDK package major and protocol version must be recorded separately. |
| MCP TypeScript SDK | [v2 docs](https://ts.sdk.modelcontextprotocol.io/v2/), [packages](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages) | Official docs describe stable v2 split server/client packages. Keep SDK behind ingress; do not use legacy v1 import paths accidentally. |
| Execa | [API](https://github.com/sindresorhus/execa/blob/main/docs/api.md) | Fixed executable/argv, controlled env, stream limits, cancellation. Graceful cancellation may require Node-specific cooperation; confirm full process cleanup separately. |
| `p-queue` | [README](https://github.com/sindresorhus/p-queue) | Optional process-local admission; timeout does not grant distributed ownership or prove child death. |
| `p-retry` | [README](https://github.com/sindresorhus/p-retry) | Optional bounded transient read retry only; explicit classifier before use. Unknown writes never enter this helper. |
| `proper-lockfile` | [README](https://github.com/moxystudio/node-proper-lockfile) | Optional local staging lock; stale-lock behavior is not authoritative fencing. No central distributed correctness dependency. |
| `async-mutex` | [Official project](https://github.com/DirtyHairy/async-mutex) | Not needed initially; in-process coordination only if measured/necessary. |
| Git | [Worktrees](https://git-scm.com/docs/git-worktree), [push](https://git-scm.com/docs/git-push) | Isolated writer checkouts, fixed arguments, target ref preconditions and serialized merge. Exact installed CLI behavior is G01 work. |
| GitHub runner model | [Placement](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job), [self-hosted reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners), [security](https://docs.github.com/en/actions/reference/security/secure-use) | Architectural precedent for group/label/availability and ephemeral cleanup; Brain uses its own protocol/binary. |

## Experience, memory and operations

| Component | Official evidence | Adoption and implementation rule |
|---|---|---|
| NewUI | [Documentation](https://talelk.github.io/newui/), [atomic kit contract](https://github.com/talelk/newui/blob/54bf4d641aa8fcaa909e5b8e29fa24de0e3492e1/spec/kit.md), [starter](https://github.com/talelk/newui/tree/54bf4d641aa8fcaa909e5b8e29fa24de0e3492e1/apps/starter) | Required UI foundation via public `@talelk/newui-*` packages. Reviewed source revision and package observations are in ui-foundation.json; installation, peer/CSS compatibility and Brain workflows still need G01/T33. See document 16. |
| SolidJS | [Resources](https://docs.solidjs.com/reference/basic-reactivity/create-resource) | Fine-grained task UI with explicit loading/error state, owned cleanup and bounded stores. |
| Solid Router | [Overview](https://docs.solidjs.com/solid-router) | SPA routes, deep links and lazy boundaries; no SSR runtime required initially. |
| Vite | [Guide](https://vite.dev/guide/) | Static build for Governor; pin Solid plugin/toolchain compatibility in G01. |
| Tailwind | [Theme tokens](https://tailwindcss.com/docs/theme) | v4 build integration with `@talelk/newui-tailwind/style.css`; consume NewUI semantic tokens and verify emitted app/package classes. |
| Zag | [Installation](https://zagjs.com/overview/installation) | NewUI owns Zag-backed interaction primitives; Brain composes their public APIs and tests product behavior. Direct Brain Zag imports require a documented library gap and review. |
| TanStack Virtual | [Solid adapter](https://tanstack.com/virtual/latest/docs/framework/solid/solid-virtual) | Prefer NewUI VirtualList/DataTable organisms. Direct rendering integration only for a documented unmet need; long views retain accessible fallback. |
| Apache ECharts | [ARIA guidance](https://echarts.apache.org/handbook/en/best-practices/aria/) | Use optional route-lazy `@talelk/newui-charts` wrappers and their semantic theme; verify accessible data fallbacks and initial-route budget. |
| TencentDB Agent Memory | [Project](https://github.com/TencentCloud/TencentDB-Agent-Memory), [MemoryCore](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/MemoryCore/README.md) | Optional at early slices; pin repo/image, test ACL/export/FTS5/private indexing and service footprint. Do not assume managed TencentDB cloud behavior. |
| Pino | [Transports](https://github.com/pinojs/pino/blob/main/docs/transports.md), [redaction](https://github.com/pinojs/pino/blob/main/docs/redaction.md) | Structured logs with off-hot-path transport; key redaction supplemented for arbitrary text. |
| Docker / Compose | [Rootless](https://docs.docker.com/engine/security/rootless/), [resources](https://docs.docker.com/engine/containers/resource_constraints/), [secrets](https://docs.docker.com/compose/how-tos/use-secrets/) | Deployment and launcher candidate; validate cgroups/network enforcement; Compose secrets are host-file mounts. |
| VictoriaLogs / VictoriaMetrics | [Logs quickstart](https://docs.victoriametrics.com/victorialogs/quickstart/), [metrics quickstart](https://docs.victoriametrics.com/victoriametrics/quick-start/) | Optional operational profiles after measured need. Never part of authorization availability. |
| ntfy | [Official documentation](https://docs.ntfy.sh/) | Optional authenticated self-hosted notifications; public unguessable topics are not tenant authorization. |
| Browser service worker/push | [Service workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API), [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) | Static caching, opt-in notifications and fallbacks; no offline approvals or guaranteed periodic background agent work. |
| WCAG | [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | AA acceptance target with manual keyboard/screen-reader checks plus browser automation. |

## Verification toolchain

| Component | Official evidence | Adoption and implementation rule |
|---|---|---|
| Vitest | [Guide](https://vitest.dev/guide/) | Domain, port conformance and integration tests; isolate IO fixtures and clocks. |
| Playwright | [Assertions](https://playwright.dev/docs/test-assertions) | Real browser workflows with web-first assertions and fixed responsive sizes; no arbitrary sleeps. |
| Evalite | [Official docs](https://evalite.dev/) | Optional TypeScript model-quality experiments after deterministic acceptance exists. |
| Promptfoo | [Introduction](https://www.promptfoo.dev/docs/intro/) | Optional external red-team/regression harness; sanitized fixtures and budget limits. Avoid duplicating Evalite without a distinct need. |
| ShellCheck | [Official tool](https://www.shellcheck.net/) | Static shell diagnostics before trusted tool publication. |
| Bats | [Documentation](https://bats-core.readthedocs.io/en/stable/) | Tool behavioral/denial fixtures when shell tests need it. |
| shfmt | [Official repository](https://github.com/mvdan/sh) | Reproducible shell formatting; no semantic proof. |

## Pin record required before an integration ships

Each selected dependency gets `name`, `exactVersionOrCommit`, `sourceURL`, `retrievedAt`, `lockIntegrity`, `imageDigest` where applicable, license/notice, transitive SBOM reference, native engine version, supported OS/architecture, smoke command, evidence path and owner. A docs URL on a moving branch is discovery evidence; preserve the exact revision/docs snapshot when pinning. An empty field is an unresolved gate, not an implicit approval.

No live package dependency tree exists in this repository yet. Consequently this pack cannot honestly provide vulnerability results, actual transitive compatibility or a deployment-certified lockfile. G01 creates that concrete evidence before runtime code relies on any recommendation. The pack's Python/TS validation versions are separate and reported in its verification artifact.
