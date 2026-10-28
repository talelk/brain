# Workspace instructions

@/home/talel/.codex/RTK.md

## Architecture

Keep the control plane a modular monolith: one Governor process and internal module folders with public function boundaries. Only `packages/contracts` is shared; keep Brain UI compositions inside `apps/web/src/ui`. Runner and trusted launcher are separate executables for isolation, not independently designed business services. Use `contracts/v1/module-layout.json` and `work-plan.json` as layout/task authorities. Full required functionality remains in scope. Generate task/navigation indexes instead of editing duplicate lists.

## Implementation policy — until the user explicitly changes it

Build the current target architecture directly. Backward/forward compatibility, historical data or configuration migration, rolling-upgrade coexistence, compatibility shims and incremental-change constraints are out of scope. Do not add legacy aliases/parsers, dual-write paths, historical backfills, migration frameworks, parallel old/new implementations or deprecated API wrappers to preserve earlier behavior.

Breaking changes and coordinated changes across modules, contracts, schemas, callers, tests and configuration are allowed. Task IDs are a coverage/dependency checklist, not a one-task-at-a-time restriction or a requirement that intermediate states remain deployable. Remove obsolete implementation when its replacement is complete. Preserve unrelated user changes and existing user data; this policy does not authorize deletion/reset of non-disposable data.

Fresh current-schema initialization, vendor-owned schema generation needed for the selected runtime, working dependency integration, same-version crash/restart recovery, immutable run/evidence references, authorization and meaningful verification remain required. These are target-system correctness requirements, not legacy compatibility work. Keep replaceable product ports/adapters; they are architecture boundaries.

Read `IMPLEMENTATION_PROMPT.md` and `contracts/v1/implementation-policy.json` when implementation is requested. Later explicit user direction takes precedence; do not infer that a generic request to test, fix or continue reinstates compatibility, migration or incremental delivery obligations.

For OpenCode use the native v2 root `opencode.json` and `docs/implementation/17-opencode-execution.md`. Explicitly read `/home/talel/.codex/RTK.md`; do not assume an assistant expands the `@file` line. Use focused task packets and the typed implementation ledger/checkpoint for context continuity, without turning them into incremental delivery restrictions. Do not mark model qualification or runtime integration gates passed from documentation checks.
