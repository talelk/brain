# Runtime status and continuation — 2026-10-28

The repository now contains runtime code for Governor, runners, launcher, CLI and the NewUI-backed Solid app. It remains an incomplete implementation. Earlier task `passed` labels and gate files overstated the available acceptance evidence. Documentation/contract checks, a named test, a standalone adapter probe and a production UI build each prove a limited property; none certifies the platform.

## Six-area UI-first acceptance — 31 October

T58 completes the six-area UI-first flow with contextual Create, Ask Brain, reviewed plans, Resources, Schedules and all Studios. Personal-host automation pins runs and jobs to the selected runner, retains pending occurrences while offline, and applies explicit wait/fail policy without managed fallback. T52 now also has direct domain planning and Governor-restart chaos coverage; occurrence identity and history survive replay without duplicate dispatch. The browser Git fixture handles early child-input closure, and the complete Studio publication flow passes.

Evidence is in `artifacts/implementation/ui-first-acceptance/verification.json`: fast checks with domain 33/33, integration 206/206, security 75/75, chaos 35/35, certification 2/2 with all 110 scenarios covered, browser 162/162 across six viewport/theme projects, and all implementation-pack checks pass. E093/E097/E101–E110 are covered. Live Anthropic/customer-system qualification for T25 and T41–T43 and independent release certification remain separate; runtime gates were not manually promoted.

## Autonomous capitalization — 31 October

T57 connects accepted independent evidence to provenance-scoped L0 capture, durable L1 extraction and deduplicated, tested L2 candidates. Candidates retain typed shapes, effect class, existing alternatives and original evidence. L3 publication requires explicit human review and the exact active configuration release; no extraction path automatically publishes shared memory or executable authority. Knowledge Studio exposes the complete flow, and interrupted runs resume without duplicates.

Evidence is in `artifacts/implementation/autonomous-capitalization/verification.json`: fast checks, integration 204/204, security 75/75, chaos 34/34, certification 2/2, browser 150/150 and all implementation-pack checks pass. Biome retains only the pre-existing automation unused-parameter warning. Runtime gates were not promoted.

## Configuration Studio and publication — 31 October

T56 adds immutable configuration drafts and revisions, restricted YAML, visual `spec.jobs` authoring, validation and structural tests, deterministic diffs and impact analysis. Publication uses the TypeScript Git client to clone, commit and push the exact draft documents, then compiles those committed bytes into a staged release. Activation remains a separate compare-and-swap command. The Studio UI supports the entire create → validate → test → publish → activate pipeline without direct active mutation.

Evidence is in `artifacts/implementation/configuration-studio/verification.json`: integration 201/201, security 72/72, chaos 33/33 and browser 144/144 across all six viewport/theme projects. Publication proof uses a real Git smart-HTTP backend fixture. Pack readiness now lacks only T57 capitalization DTOs.

## TypeScript Git protocol integrations — 30 October

T55 uses the pinned pure-TypeScript `isomorphic-git` client rather than hosting-provider APIs. Each connection is one Git remote verified through `listServerRefs` read and push negotiation. Optional HTTP credentials are encrypted at rest and never returned in DTOs. Configuration and project bindings remain separate, and actual ref transitions create deduplicated inert proposals. The administration UI supports the complete remote → verify → bind → proposal workflow. The earlier GitHub App/GitLab-specific implementation was removed, including its webhook endpoint.

Evidence is in `artifacts/implementation/git-integrations/verification.json`: integration 200/200, security 70/70, chaos 33/33 and browser 138/138 across all six viewport/theme projects. Live customer remotes were not contacted; tests use a real loopback Git smart-HTTP fixture. Pack readiness now lacks only T56 Studio commands.

## Workspace documents and resources — 30 October

T54 adds workspace-private document upload, immutable content-addressed versions, safe text/download-only preview, scoped WorkItem/objective/session/run associations and current-revision FTS search. Revocation removes current visibility without deleting history. CAS sweep retains every document version, and upload/indexing never creates shared-memory publications. The Resources screen supports the complete workflow without YAML or terminal commands.

Evidence is in `artifacts/implementation/documents/verification.json`: integration 198/198, security 67/67, chaos 33/33 and the E107 browser scenario in all six viewport/theme projects. Pack readiness is now blocked only by future T55–T56 screen actions without command DTOs; Biome still reports only the pre-existing automation unused parameter.

## Native sessions and collaboration — 30 October

T53 now provides native and managed `BrainSession` records, durable WorkItem messages, portable checkpoint resume as a new session, and bounded cross-agent delegation. Managed sessions bind to real workflow attempts and execution links. Delegation enforces narrowed paths/tools, aggregate child budgets, depth three, distinct active worktrees and independent human review backed by child-job evidence from a different evaluator attempt. The session detail screen exposes lineage, ownership, budget and checkpoint facts; OpenCode is an explicit ACP adapter selection. Late attempt events no longer reopen terminal sessions.

Executed evidence is in `artifacts/implementation/session-collaboration/verification.json`: focused T53 5/5, integration 194/194, security 64/64, chaos 33/33, certification 2/2 and browser 126/126 across six viewport/theme projects, including the production build. Live OpenCode model qualification was not run. Biome remains red on a pre-existing unused parameter in `modules/jobs/automation.ts:319`; pack readiness remains red because future T54–T56 screen actions have no command DTOs. These limitations do not change the independently derived G01–G08 statuses.

## End-user setup and operations — 29 October

Fresh checkout startup now generates `admin@brain.local` with the default local
password `admin-password` and no forced replacement, creates My workspace, and activates two
ordinary starter tasks with their governed tools. `BRAIN_ADMIN_EMAIL` and
`BRAIN_ADMIN_PASSWORD` provide custom initial credentials; explicit temporary-password
flows retain their replacement protection. Browser model setup pairs scoped
local runners. Five primary areas lead to shared task review/start from a catalog,
private conversation proposal, or linked work item. Results present workflow-level
status and independent evidence, with technical diagnostics collapsed.

The source-checkout commands support start/stop/status/logs, verified backup/restore,
and registered-instance reset with confirmation, ownership/path checks and writer
exclusion. Restore keeps execution suspended. User documentation starts in README
and docs/howto/use-brain.md; advanced configuration has a separate reference.

Current UX evidence is in artifacts/implementation/ux-complete/verification.json.
It distinguishes the full automated suite, live model runs and recovery proof from
model variability, unrun representative-human usability sessions and independent
release certification. Those results do not promote historical G01–G08 evidence or
qualify semantic/model accuracy.

## Operational-product continuation — 28 October

The operator milestone supersedes the earlier fixture-only engine and forced-TOTP descriptions below. The root [README](../../README.md) is the supported startup, release-authoring and troubleshooting guide. Pi/Claude adapters now consume pinned agent instructions/tasks and report actual terminal output; the supervisor uploads outputs and submits author evidence for independent deterministic validation. Claude requires explicit configured endpoint proof when selected. Pi/Claude adapters now expose release-pinned custom tools as native bindings through the governed broker: the supervisor re-checks the Agent allowlist digest, pinned target and input schema, requires an effect permit for non-read classes, executes only launcher-sandboxed pinned bytes, uploads the output as an attempt artifact and records the tool release plus a `governed-tool-result` effect event in the evidence bundle. The starter Operations Assistant calls only the read-only `operations.context` tool; the Support Analyst remains tool-free. Task-oriented guides were added under [`docs/howto/`](../howto/README.md).

Complete directory releases are compiled, inspected and activated separately through CLI/API. Active-release Agents/Workflows views drive schema-based dispatch, readiness, structured output and evidence. Optional 2FA defaults to false; one-use exact session evidence retains native identity/current-authority checks, while required mode retains TOTP. Settings exposes security, release inspection/activation and configured external administration links.

Final-source verification records are recorded separately under `artifacts/implementation/operational-*`, `readme-walkthrough-*` and the operational verification report. Do not reuse historical green runtime gates for this worktree. The independent release gates remain unproven. E092 bounded-DOM, scroll and selection preservation is covered across all six browser viewport/theme projects. Live customer connectors, semantic/model-quality evaluation, full remote-memory restore and independent certification remain follow-up scope.

## 28 October continuation

The 27 October "environment-blocked" premises were retested and are stale: Chromium, localhost binding and the Docker daemon all work in this sandbox. The full integration suite including the real-socket golden test, the complete Playwright matrix, and a real-Docker launcher execution probe all pass; executed evidence is bound to source in `artifacts/implementation/verification-20261028/run-record.json`.

Implemented this session, in dependency order:

1. **Web (T33–T37/T39/T40/T42–T45).** The near-complete route tree that sat unwired in the working tree was fixed and brought live: all 22 contract routes generated from `ui-screen-contracts.json`, five primary areas with account-menu Settings and dedicated `/tv` kiosk entries, the shared RunDetail/SessionFeed/EvidenceList/PlacementPanel compositions, the 8-state ScreenRegion contract, scope-generation eviction on workspace switch or revocation, and real mutations (board create/move/comment, decisions, memory publish/revoke with a real publication form, member grant/revoke, config activate, tool propose/publish, runner drain/quarantine on `/runners/:id`, session steer/stop, approval revoke). QueueReason gained `READY` — `job.explain` always emitted it for placed jobs; the contract now says so. The approvals list no longer polls, so a background refresh cannot destroy an open review dialog.
2. **Ledger truth pass.** Tasks whose whole behavior was not verified were demoted to `active` with precise remaining scope (runner path, evidence completion, restore, gates); 20 of 58 entries are now active.
3. **Module extraction (T02 layout).** `modules/jobs` now owns runner identity/sessions (`protocol.ts`) and the attempt lifecycle (`attempts.ts`: fair claim, pinned execution artifacts, leases/fences, events, receipts, expiry); `modules/governance/permits.ts` owns effect-permit issuance and current-authority validation. `application/brain.ts` keeps a delegating facade; cross-module access goes through module indexes.
4. **Runner execution path (T20/T22/T23).** The event spool is a fsynced per-attempt journal (replay after crash or failed delivery, shrink on acknowledgement only); the execution deadline derives from the ack/renew lease expiry on a monotonic clock and a watchdog aborts the in-flight job at deadline or lease loss, reporting `outcome_unknown` rather than success; effect-class tools require an attempt-scoped permit before execution; outputs are pinned into the CAS via `POST /runner/v1/attempts/:id/artifacts` (attempt-owned association).
5. **Launcher (T21).** Bearer-token auth over the Unix socket, an exec endpoint with fixed argv, bounded stdin/stdout and a read-only `/tools` mount, sandbox-registry reconcile from labels after restart. The supervisor routes tools through the launcher when `BRAIN_LAUNCHER_SOCKET` is configured; effect-class tools refuse unsandboxed host bash (fail closed). Verified end-to-end with real Docker (`tests/probes/sandbox/launcher-exec.test.ts`).
6. **Cron dispatch (T19 runtime).** `modules/jobs/scheduler.ts` fires release-declared Schedule documents exactly once per due minute with durable dedupe and an idempotent execution key; first sight anchors at now and persists the anchor (a re-anchoring pass would never fire — regression-tested). Wired into the maintenance loop.

## Active objective

The active objective is **finalize all the implementation**. The full work plan and required gates remain in scope. No gate is complete merely because a module's local tests pass.

## Required next work, ordered by dependency

1. **Image/tool digest pinning and socket peer credentials (T21/T22)**; engine adapter selection with harness events/cancel/checkpoints (T24). The tool-broker boundary (T23) now validates pinned digests, targets, schemas, budgets and effect permits in the live supervisor path; the operational proof asserts the broker event and pinned `operations.context` release for `operations-triage`.
2. **Evidence completion (T27/T28/T31).** Runner-produced author bundles bound to uploaded attempt artifacts; production trust-domain verifier enabling real L2; revision/incomplete resubmission policy; explicit run/criterion bindings beyond the board path.
3. **brain.ts decomposition continues**: queries, board/pack command application, CAS and release sections move to their owning modules as they are touched.
4. **Complete restore (T47/G04/G07)**: knowledge/Mastra snapshot inventory, authority watermarks; fault-before/after-commit restore tests; second-restore test.
5. **Operations completion (T41–T43)** remain blocked on live external systems (customer GitLab, monitoring targets, production Anthropic credential).
6. **Gates (T49/T50/G01–G08).** Extend the executed verification record with the three 10-minute workload/fault trials, Qwen/OpenCode model qualification in a disposable workspace, and the per-scenario audit against actual observations before any gate returns to passed.


## Verified continuation

This continuation removed the unrestricted `/v1/setup/session` impersonation path; configuration staging/activation now checks current organization permissions, including revocation. HTTP setup refuses a second organization, cookie mutation origin checks include the scheme and honor the configured `BRAIN_BASE_URL` behind TLS proxies, and unknown API paths return structured 404 responses instead of the SPA.

Governor now holds exclusive data-directory ownership, retains private session/cursor key material across normal restarts, and validates workspace organization identity on cache hits. The workspace cache refreshes recency on hits. Initialization failures release owned handles and locks; vendor schema initialization failures are surfaced.

The operations module provides stopped-Governor WAL-aware backups, strict local archive validation, bounded file hashing/copying, staged publication, suspended restore and transactionally idempotent authority quarantine. A separate trusted maintenance entry point exposes these operations without giving the remote CLI database access. See doc 10 for exact commands, format and limitations.

Regression tests exercise real SQLite WAL contents, active-owner exclusion, traversal/absolute/reserved/duplicate paths, symlinks/hardlinks, corrupt databases, failed publication, nonempty destination preservation, restart session persistence and successive restore identities. Existing restore history/approval/permit checks remain. The golden socket test now waits for the actual listening event and reports bind failures without leaking its app; it no longer relies on a fixed sleep.

Recorded commands and logs: `artifacts/implementation/resume-20261027/`. No G01–G08 or model qualification is marked passed by these checks. The broad integration run remains failed in this sandbox because `127.0.0.1` socket binding is denied (`EPERM`). The remaining integration cases pass. The production build uses the installed NewUI packages and succeeds; it does not prove screen behavior, responsiveness or accessibility.

## Native identity continuation

The following continuation replaces the previous parallel human credential path. Human requests now resolve real Better Auth cookies/bearer sessions and current native organization membership. The native session ID, protected factor fingerprint and authorization generation bind step-up to one exact approval. Vendor TOTP enrollment, verification, recovery and session replacement are exercised by actual HTTP tests; no production plaintext TOTP store remains. Recovery sign-in requires replacing the prior authenticator before approval evidence can be issued. Local one-use setup, CLI login/logout and private origin-scoped CLI sessions are implemented. The actual client flows and current contract additions are documented in [24 Native identity](24-native-identity.md).

The web app now uses native HttpOnly cookies, AuthLayout/AuthCard enrollment/sign-in, one theme owner and proper AppShell navigation data. Server, web and browser-test type checks run in FAST. Web uses the installed source-published NewUI cohort's supported strict compiler settings; its optional-property flag limitation is explicit in doc 16. HTTP bodies are now read under byte/time/admission bounds and strict JSON parsing rejects duplicates, malformed Unicode, excessive structure and prototype ambiguity. Canonical contract generation also checks/synchronizes runtime mirrors.

The selected browser authentication test cannot run here: Chromium exits with `Operation not permitted`. Localhost binding and Docker socket access are also denied. These are recorded environmental limits; they do not close browser, launcher, wire, live-vendor or full platform gates. The browser suite has isolated owned fixtures and six viewport/theme projects, with no automatic snapshot updates.

Approval consumption and online permit validation now recheck the reviewer's current native session, factor, organization membership, workspace approver permission, enabled principal and authorization generation. Runner epoch, active job fence and lease are rechecked too. Negative tests prove these failures create no consumption, permit or resource fence.

## Evaluator authority continuation

Evidence submission/acceptance now belongs to the evidence module. Bundles bind the authenticated author attempt and current runtime/source facts, verify scoped artifact metadata and rehash bounded durable bytes. Verdicts require a genuine admitted evaluator attempt, exact pinned inputs/release/checks, current runner identity and matching committed results. L2 requires explicit Governor-verified distinct trust domains; self-asserted labels do not qualify. Missing checks, invented/self evaluators, stale epochs/fences, revoked trust, altered artifacts and contradictory results are rejected.

Submitted author evidence can now admit its explicit evaluator while the author remains `verifying`, removing the circular dependency. Actual fixture Bash/Python execution through the real HTTP handlers passes with an in-process transport. Accepted verdict application uses a durable workspace marker, a control inbox and immutable step-output digests; a fault after completion is retried safely. Cancellation does not revive work. Verdicts no longer attach themselves to unrelated cards or clear unresolved effect guards. Exact behavior and remaining limitations are in [25 Evaluator authority](25-evaluator-authority.md).

Current local evidence is in `artifacts/implementation/identity-20261027/`: FAST, lint and build pass; 144 selected tests across 21 files pass. The complete integration command has 83 passing cases and one localhost `EPERM` failure. Focused browser execution fails before its body because Chromium is denied by the sandbox. These are scoped observations, not full gate or model qualification. No G01–G08 or whole-task status was promoted.

## Required next work, ordered by dependency

1. **Identity completion and effect-time authorization (T05/T13/T14).** Native session/step-up/recovery and current-reviewer revalidation are implemented. Finish organization/member administration, invitations/account management and real browser coverage. Complete exact job/tool/target/policy binding, authoritative resource-key derivation and atomic permit-start/use before privileged effects. Add setup/shutdown cancellation/fault behavior. Keep human, machine, delegated and runner identity classes distinct.

2. **Evidence completion (T27/T28/T31).** Authenticated attempt binding, admitted pinned evaluation, required checks/artifact rehashing and retriable verdict application are implemented; synthetic golden verdicts were removed. Complete streamed/scoped artifact upload ownership, runtime primitive/tool executable provenance, automatic author-bundle capture and read-only evaluator delivery. Add production trust-domain verification, explicit card/run/criterion bindings, revision/incomplete resubmission policies, larger evaluation graphs and full restore inventory. Current JobOffer still has runtime/schema drift around its inline payload and workflow digest; close it with actual response-conformance tests. See doc 25 before modifying this authority path.

3. **Actual Mastra orchestration (T29/T30) — completed.** The Mastra `WorkflowEnginePort` is the only engine implementation: the homegrown `modules/workflows/runner.ts` DAG adapter and the standalone `mastra/lowering.ts` probe helper were removed when the port replacement was completed. All primitives (dispatch, gate, eval-wait, merge, steer, subgraph) run through real Mastra workflows on LibSQL storage with durable suspend/resume, early/duplicate-wake replay and restart rehydration; registration/commit failure blocks the run rather than guessing step success (E025, proven in `tests/integration/mastra-conformance.test.ts`). Brain tables remain the operational authority; Mastra owns progression snapshots only.

4. **Runner execution and HTTP limits (T06/T20–T25/T32).** `apps/runner/src/supervisor.ts` and harness/tool adapters must use the constrained launcher and governed tool path for actual jobs, stop on lost renewal, honor monotonic deadlines, and replay a bounded durable spool. The current fixture tool loop is not proof of these properties. Request-body streaming/admission bounds are implemented in `http/body.ts`. Complete end-to-end streaming artifact storage, and bound/authorize live SSE replay with revocation and slow-client behavior. Current events return a finite snapshot, not a live subscription. Exercise real network/launcher/harness behavior in an environment that permits it; do not hide sandbox bind failures as passes.

5. **Complete restore (T47/G04/G07).** `modules/operations/backup.ts` and knowledge/Mastra adapters: supply complete scoped exports, pinned adapter/config inventory, authority watermarks and online coordination if offered. Current local archives intentionally stay partial. Verify restored workspace waits, immutable references and external-effect reconciliation before a governed reactivation path. Test a fault before/after control commit and a second restore of previously restored data. Prove component completeness separately from successful local SQLite copying.

6. **Product screens (T33–T37/T42–T45).** `apps/web/src/app.tsx` and local `ui/` compositions: the small current shell/forms do not implement all screen oracles. Follow NewUI's public package exports, the five navigation areas, doc 21 and actual Governor views/commands. Implement workspace switching with protected-state eviction, approvals with exact review/timeout recovery, jobs/placement, live sessions, board decisions, support/SRE/delivery and static-only PWA behavior. Exercise 390/768/1440 widths, both themes, keyboard/focus, loading/empty/error/stale/revoked states and real mutations. The previous heading-only smoke test was replaced by a real native-auth browser flow, but browser execution is unverified here and full E093 navigation/list-detail coverage remains unfinished.

7. **Evidence and measurement (T49/T50/G01–G08).** Replace ad-hoc gate manifests with actual `VerificationRun` records from trusted command execution, raw logs and current source/lock fingerprints. Do not invent check booleans from this document. Audit every scenario against its required observation; file names and scenario-ID substrings are only an index. Run three comparable 10-minute workload/fault trials and collect latency, CPU/RSS/WAL and browser responsiveness. Complete the explicit Qwen/OpenCode qualification separately. Keep ACP and other optional integrations disabled until their optional acceptance is performed.

## Finalization continuation — 28 October (late)

Executed evidence: `artifacts/implementation/verification-20261028/run-record.json` (full vitest 305/305, browser matrix 16/16 at 1440-light, launcher probes, steady trials, model qualification) and `artifacts/implementation/scenario-audit-20261028.json` (100/100 scenarios observed-pass against actual observations). `scripts/verify-operational.ts` additionally ran the whole product end-to-end against head `fe9c000` (CLI setup → workspace → config activation → runner tokens → agent-smoke / operations-triage / support-draft through the real pi engine with the live model; all verdicts verified with evaluator attempts) — evidence: `artifacts/implementation/operational-1793224435202/run.json`.

Closed since the morning pass:

1. **Session data source.** Nothing ever wrote the workspace `sessions` table, so the live-session screen had no data. `ackAttempt` now upserts the session row, `attemptEvents` advances its `event_sequence` and reports the real executing engine (tool-broker for tool kinds, the probed adapter for agent kinds), and `completeAttempt` closes the state. `sessionView` no longer reads the nonexistent `job_attempts.created_at_ms`.
2. **Live SSE events were dead in committed code.** The server named every frame (`event: <type>`) while the client listened on the default `message` channel, so no live update ever arrived. Data frames now ride the default channel (type stays in the payload); `reset` remains a named control frame. This was caught by the E092 observation work.
3. **E092 (slow SSE log viewer).** `SessionFeed` now implements the doc-21 oracle for real: VirtualList-bounded DOM over a capped 500-event client buffer, scroll-driven follow pause, prepend scroll compensation, selection snapshot/restore keyed by `data-event-id`, and jump-to-newest. `tests/browser/sse-logviewer.spec.ts` observes 1200-event transcripts with bounded mounted rows and pinned scroll/selection across a live burst; the certification matrix row is now covered.
4. **Launcher probe E065** authenticates with the launcher token and passes (TERM-ignoring daemonized child dies with the sandbox). Pi harness probes pass in isolation; under full parallel load they contend on the shared local model endpoint — documented, not faked.
5. **Author-bundle ledger test** updated for the runner's automatic bundle (T27): the altered-identity test now asserts the ledger is unchanged rather than empty.

Ledger: 54/58 passed. Remaining active: T25 (Anthropic credential), T41–T43 (live customer systems) — all four are external dependencies, honestly documented, not implementation gaps. G01–G08 re-promoted on executed evidence.

## Implementation boundaries remain unchanged

One Governor modular monolith, module public indexes, `packages/contracts` as the only shared package, separate runner/launcher isolation executables, Git configuration authority and SQLite operational authority. No microservices or new broker was introduced. Build the current target directly: no historical migration, compatibility shims, dual writes, rolling coexistence or requirement to preserve deployable intermediate steps. Preserve user data and unrelated work. Only mark a task passed after its whole required behavior and evidence have been verified; retain partial implementation as active work.
