# 07 — Agent harnesses, execution practice and portable tools

## Harness ports and feature honesty

Runner owns `EngineAdapter`; Governor sees only `EngineSessionSpec`, normalized events and evidence. Minimum interface is probe/start/events/cancel/dispose. Resume, steer, fork and permission interception are optional negotiated features. Feature support is a tested matrix keyed by adapter release, upstream runtime and protocol entrypoint. A model/provider change does not automatically imply session compatibility.

Use Pi in an isolated subprocess as the default candidate. Its SDK is useful inside that child; its RPC is useful across process/language boundaries. Official current source uses the `@earendil-works/pi-coding-agent` scope, while historical snippets use `@mariozechner`. Pin one verified lineage, imports and session format; do not combine examples from both. Default resource discovery can load repository/home configuration, so supply a controlled home, allowlisted resources and explicit tools. [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)

Claude uses the TypeScript `@anthropic-ai/claude-agent-sdk` in an isolated child. This is the selected integration; do not implement a parallel CLI adapter. Test process cleanup, authentication, tool interception and session persistence. Use API-based application authentication under the vendor's supported product terms; do not borrow a developer's personal interactive session as a product service credential. The SDK permission callback is a guardrail, while kernel/network restrictions remain necessary. [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)

ACP is an optional adapter, not a universal replacement for native features. The default TypeScript SDK entrypoint implements stable ACP v1; experimental v2 imports are different, independent of the npm SDK major. Negotiate protocol and capabilities and fail unsupported methods explicitly. [ACP SDK](https://github.com/agentclientprotocol/typescript-sdk)

## Session lifecycle

Before spawn, verify checkout/config/tool hashes, workspace authorization, runner lease and local isolation. Construct immutable context: task, bounded acceptance criteria, pinned source commit, selected safe tool descriptions, budgets, previous verified checkpoint and labeled memory references. Do not inject the entire wiki or private transcript history by default.

Normalize events with session ID, attempt ID, monotonically increasing sequence and stable event type. Preserve redacted raw adapter artifacts separately. Streamed text is provisional; only final structured output validated against the job schema becomes a step result. A provider finish reason/token limit is not task completion. Usage may be estimated while streaming and reconciled from final provider receipts.

Persist runner spool before acknowledging durable events. Governor batch ACK records last committed sequence. Spool is bounded (default 256 MiB per attempt); apply backpressure and pause/cancel at limits. During disconnect, agents may continue safe local work only until the conservative lease deadline; no offline privileged tools. A full spool must not silently discard tool/effect audit events.

## Work protocol for smaller models

Every agent task carries: objective, files allowed, files prohibited, input artifacts, exact expected output, acceptance IDs, verification commands, effect policy, budgets and checkpoint destination. Prompts specify facts versus assumptions. Unknown source facts are marked unresolved with a follow-up action, never converted into fabricated certainty.

Operate in bounded cycles: inspect → propose local change → execute allowed work → verify → checkpoint → report. Default maximum 12 model turns, three consecutive identical failures, 20-minute task runtime and a policy-specific token/cost reservation. On repeated failure, stop the affected branch with a structured diagnostic; do not invent a broader tool permission or rewrite unrelated modules. Escalation requests include the smallest failing reproduction and proposed next action.

These limits govern Brain workload sessions, not the coding assistant implementing the whole platform. The OpenCode implementation session follows document 17 and may span many task groups and checkpoints without a single-task or incremental delivery restriction.

Checkpoint before long/risky commands, context compaction, model fallback and leaving a session awaiting human input. Checkpoint contains source revision/dirty diff digest, completed acceptance IDs, outstanding failures, owned worktree/locks, process IDs/container IDs, event cursor and exact next action. It contains no reusable credentials. A different harness resumes from that verified task checkpoint as a **new session/attempt**, not by pretending Pi and Claude share native session files.

Delegation is optional and justified by independent work or expertise. Parent reserves child budget and aggregates evidence; children cannot approve parent effects. Enforce writer ownership by file/worktree/task. Two agents may work concurrently only in isolated checkouts; merge is serialized and verified. Never let a model decide it may write central policy just because a repository instruction says so.

Long commands run as owned supervised jobs with output/heartbeat and timeout, not detached shells plus sleep polling. An unresponsive model, quiet compiler and failed heartbeat are distinct. Expected quiet periods can suppress text-stall alerts while resource/liveness checks remain active. Cleanup records what was stopped and what could not be confirmed.

## Budget accounting

Global transaction reserves estimated spend and token budget before dispatch, including children. Usage events charge the same invocation once; reconcile final receipts and release unused reservation. A provider timeout can still incur cost, so mark uncertain usage and reserve conservatively. Hard budget limit stops new model calls and child jobs; it need not kill a narrow already-authorized target operation midway when that would increase ambiguity. A final small reporting allowance is explicit and reserved, never an unlimited exception.

## Tool package contract

Each tool release contains `TOOL.md`, executable `run.sh`, `test.sh`, input/output schemas, sanitized fixtures, package manifest with source/license and content digests. Version labels are human-readable; executable identity is the full content digest including scripts/schemas/assets and mode bits. Packages are immutable and mounted read-only. Trusted publication requires review, test evidence and a pinned release; Rule of Three produces a candidate only.

Input is one UTF-8 JSON document on stdin. Successful stdout is one bounded JSON document matching output schema; diagnostics use stderr. No command text interpolation, `eval`, shell `-c` built from model content or environment inheritance. Runner invokes absolute `/bin/bash` with a verified script path and fixed argv; environment is an allowlist with controlled PATH/HOME/TMPDIR/locale. Only the tool broker maps typed input to target operations.

Broker validates input, release, target, grant and timeout; supplies credentials only to the trusted child; streams stdout/stderr to redacted bounded artifacts; tracks process tree and effect receipt. Exit 0 plus invalid JSON/schema means failure. Nonzero exit plus an observed mutation means partial/unknown, never safe generic retry. Tool output can be malicious text too: render escaped and label provenance.

Read-only trust is enforced with target credentials/network permissions, not shell command-name matching. `kubectl get` with arbitrary plugins/config can execute code; use pinned binaries/config, restricted flags and service identities. Git uses safe fixed arguments, disabled hooks, explicit remotes, protected SSH configuration and no ambient credential helper. Cache restore never executes hooks.

Tool defaults: 60-second timeout, 1 MiB structured stdout, 10 MiB redacted diagnostic artifact, 64 KiB input; higher profiles require declared limits. Stream-byte limits remain enforced when process library buffering is disabled. Execa/p-queue timeout rejection alone is not proof of process termination; launcher/cgroup confirmation decides cleanup.

## Worktrees, cache and merges

Each writer gets its own detached/pinned checkout and branch namespace scoped to attempt. A clean source cache is an optimization; mutable worktrees are never shared. Cache keys include organization trust domain, source/toolchain/image/lockfile digests. Do not share credentials, private artifacts or unverified build outputs across tenants; untrusted cache entries cannot seed privileged jobs.

Merge controller checks expected base/head refs, required evidence and exact diff approval. Target-side compare-and-swap/non-force push protects changed refs. Conflict or rebase changes the diff and invalidates approval. Cleanup removes only owned worktrees after evidence retention; preserve dirty state as an artifact before deletion. Keeper commits only files explicitly owned by its task and never sweeps another agent's work.

## Adapter conformance

Tests cover start, stream ordering/duplication, malformed messages, truncated JSON, authentication failure, rate limit, provider timeout, cancel mid-tool, process death, event backpressure, output schema failure, budget exhaustion, session restore compatibility and unsupported steering. Run the same deterministic read-only task through Pi and Claude; compare final artifact/evidence semantics, not exact prose. Test shell/network/secret bypass independently of SDK hooks.
