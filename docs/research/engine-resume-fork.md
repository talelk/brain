# Engine session resume, fork and steering

Research for [#21](https://github.com/talelk/brain/issues/21) (part of map [#6](https://github.com/talelk/brain/issues/6)). Researched 2026-11-07.

Question: which runner engines natively support session resume, fork and steering a live session? What state has to be persisted to resume, and what limits apply (expiry, model change, host/container change)?

Every claim cites a primary source: installed package source/types, official docs, the ACP schema, or a live probe. Anything without a primary-source confirmation is marked **UNVERIFIED**.

## Versions examined

| Engine | Version | How pinned / observed |
|---|---|---|
| Pi | `@earendil-works/pi-coding-agent` 1.4.0 | `apps/runner/package.json`; installed `node_modules/.../pi-coding-agent/{docs,dist}` |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` 0.3.311 (bundles Claude Code 2.1.311 per `manifest.json`) | `apps/runner/package.json`; installed `sdk.d.ts` |
| OpenCode | 2.2.5 (locally installed binary, not pinned by the repo) | `opencode --version`; live ACP `initialize` probe |
| ACP | protocol v1, schema tag `schema-v1.29.1` (2026-11-02); TS SDK `@agentclientprotocol/sdk` 2.4.0 (npm latest; listed only as *optional* in `contracts/v1/dependency-baseline.json`, not installed) | GitHub `agentclientprotocol/agent-client-protocol`, unpkg |

Brain's `OpenCodeEngine` is just `AcpEngine` running `opencode acp` (`apps/runner/src/engines/opencode.ts`). Through Brain, OpenCode's reachable surface is therefore its ACP surface.

## Matrix: native engine capability

| | Pi 1.4.0 | Claude Agent SDK 0.3.311 | OpenCode 2.2.5 | ACP stable v1 |
|---|---|---|---|---|
| **Resume** | Yes. `SessionManager.open(path)`, `continueRecent(cwd)`, `findById(cwd,id)` [P1][P2] | Yes. `options.resume: <sessionId>`, `continue: true`; `resumeSessionAt` truncates at a message [C1][C2] | Yes. CLI `run --session/--continue`; ACP `session/load` + `session/resume` advertised [O1][O2] | Yes, optional. `session/load` (gated by `loadSession`, **replays** history) and `session/resume` (gated by `sessionCapabilities.resume`, **no** replay) [A1][A2] |
| **Fork** | Yes. `SessionManager.forkFrom(src, targetCwd)`, `createBranchedSession(leafId)`, in-file tree branching `branch()`; `AgentSessionRuntime.fork()` [P1][P2] | Yes. `forkSession: true` with `resume`, or standalone `forkSession(id, {upToMessageId})`. New UUIDs; **file-history snapshots not copied** [C1][C2] | Yes. CLI `run --fork`, HTTP `POST /session/:id/fork {messageID?}`; ACP `fork` capability advertised [O1][O2][O3] | **No, not stable.** `session/fork` exists only in `schema.unstable.json` ("UNSTABLE ... may be removed or changed"). TS SDK exposes it only via `@agentclientprotocol/sdk/unstable`, not the default entrypoint [A1][A3] |
| **Steer live session** | Yes. `session.steer(text)` (delivered after the current assistant turn's tool calls, before the next LLM call), `followUp(text)`; `prompt()` while streaming **throws** unless `streamingBehavior` is given [P3][P4] | Yes, in streaming-input mode only: `prompt` as `AsyncIterable<SDKUserMessage>` or `Query.streamInput()`, `SDKUserMessage.priority: 'now'|'next'|'later'`, `interrupt()`. Single-message (string) mode has "no dynamic message queueing / real-time interruption" [C2][C3] | **UNVERIFIED.** HTTP `prompt_async` exists; docs don't say what happens to a message sent while a session is busy [O3]. Over ACP: same as ACP column | **No.** Only `session/cancel`. Docs: "Once a prompt turn completes, the Client may send another `session/prompt`". The only mid-turn control is cancel [A4] |
| **Resume state to persist** | Session JSONL file (header `{type:"session",version:3,id,cwd,parentSession?}` + entry tree). Default `~/.pi/agent/sessions/<encoded-cwd>/`, overridable by `sessionDir`/`PI_CODING_AGENT_SESSION_DIR` [P1][P5] | Session UUID + transcript `~/.claude/projects/<encoded-cwd>/<id>.jsonl` (or `$CLAUDE_CONFIG_DIR/projects/`), plus `<id>/subagents/*.jsonl`. Optional `sessionStore` mirror (alpha) [C1][C2] | Session ID + OpenCode data dir `~/.local/share/opencode/` (`opencode.db` SQLite + WAL, `snapshot/`, `storage/`, `tool-output/`). `opencode session export/import` JSON [O1][O4] | Session ID (agent-owned storage), plus `cwd`, `mcpServers` and the same `systemPrompt` the client must resend on load/resume [A2] |
| **Files / worktree** | Not restored. Session is conversation only (UNVERIFIED that Pi has no file snapshot feature; none seen in docs) | Not restored. "Sessions persist the conversation, not the filesystem"; opt-in `enableFileCheckpointing` + `rewindFiles()` [C1][C2] | Not restored on resume; separate revert/unrevert + `snapshot/` dir [O3][O4] | Out of scope of protocol |
| **Expiry** | None documented (UNVERIFIED) | Transcripts auto-deleted after `cleanupPeriodDays` (default **30**) [C2]. Whether this applies with `settingSources: []` is UNVERIFIED | None documented (UNVERIFIED) | Agent-defined |
| **Model change** | Allowed: `model_change` entries in the session; restoring with a different model yields `modelFallbackMessage` [P5][P6] | `setModel()` mid-session; a model is "restored while resuming a session" [C2]. Whether `options.model` overrides the restored model on resume is UNVERIFIED | `run --model` per invocation; per-message model in API. Effect on resume is UNVERIFIED | `session/set_config_option` (`model_config` category, stabilized in schema #1502) [A5] |
| **Other host / container** | Portable file. Header stores `cwd`; `open(path, dir, cwdOverride)` is needed when the path differs [P2] | "Same machine only" unless the `.jsonl` is moved under `~/.claude/projects/` on the new host or a `sessionStore` is used. The store key derives from `cwd`, so the `cwd` must match [C1] | Export/import JSON (ID preservation on import UNVERIFIED); otherwise same data dir | Agent-defined; nothing in the protocol |

## Matrix: what Brain's adapter does today

`apps/runner/src/engines/*.ts` at commit `863ebd7`:

| | Pi (`pi.ts`) | Claude (`claude.ts`) | OpenCode / ACP (`acp.ts`, `opencode.ts`) |
|---|---|---|---|
| Probe features | `sessions, checkpoint, resume, steer` | `sessions` (only for `-local` versions) | `sessions` |
| Session ID | Pi's real `getSessionId()` | **Synthetic** `claude-<ts>`. The SDK `session_id` is never captured, so native resume is impossible as written | Real ACP `sessionId` from `session/new` |
| Resume | Copies session JSONL to `checkpoints/<digest>.jsonl` and `resume()` calls `SessionManager.open(<that path>)` | None | None. `loadSession` / `sessionCapabilities` are never read |
| Fork | None | None | None |
| Steer | Calls `session.prompt()` **without `streamingBehavior`**. Per `agent-session.d.ts` this throws while streaming, so a mid-run steer always fails with `UNSUPPORTED_CAPABILITY`. When idle it starts a new run rather than steering. Should call `session.steer()` | Throws `UNSUPPORTED_CAPABILITY`. Comment says the SDK has no injection point, but that is only true because the adapter uses string-prompt mode; `streamInput` / `priority` exist [C2][C3] | Throws `UNSUPPORTED_CAPABILITY` (correct for stable ACP) |

### Defects found in the Pi checkpoint/resume path

1. **The checkpoint artifact is mutated.** `SessionManager.open(path)` makes `path` the live session file (`dist/core/session-manager.js:1326-1348`), and `_persist` appends every new entry to it (`:794-812`). `resume()` opens `checkpoints/<digest>.jsonl` directly, so the content-addressed checkpoint stops matching its digest after the first new turn. That breaks the immutable-evidence requirement, and a second resume from the same checkpoint fails the digest check. Fix: `SessionManager.forkFrom(path, cwd, sessionsDir)`, or copy before `open`.
2. **No `cwdOverride`.** `open()` uses the header `cwd` (`:1344`). Restoring in a different worktree or container path runs tools against the original path.
3. **The session JSONL is stored in `Checkpoint.diff`.** That slot is meant for the source diff (doc 07 §Checkpoint), so worktree state isn't captured.
4. **`resume()` reuses the old `sessionId`** (`this.sessionId = sessionId`). This conflicts with the "resume from checkpoint = new attempt" rule below.

## Implications for checkpoint semantics

- **Native resume is an optional per-engine optimisation, never the checkpoint mechanism.** Only Pi and Claude expose resume/fork through stable APIs. ACP stable v1 has load/resume but **no fork and no steering**, and agents may advertise none of it. Doc 07 already says that a different harness resumes "as a new session/attempt". This research supports making that the rule for every engine.
- **Resuming from a checkpoint always creates a new attempt.** The engine-portable checkpoint is Brain's own record: source revision + diff artifact, acceptance state, event cursor, next action. A native transcript (Pi JSONL, Claude `.jsonl`, OpenCode export) can be attached as an *optional, digest-pinned, engine+version-keyed* artifact. If the engine supports it, the new attempt uses it to warm-start, preferably through a **fork**, so the pinned artifact is never appended to. Otherwise the new attempt rebuilds from the checkpoint prompt.
- **No engine restores files.** The worktree diff/commit stays Brain's responsibility in every case.
- **Native transcripts are host-local and expiring.** Claude's are kept 30 days by default and are same-machine without a `sessionStore`. Pi needs `cwdOverride`. OpenCode needs its SQLite data dir or an export. Brain must copy the bytes into its artifact store at checkpoint time and must not rely on vendor storage.
- **A model change does not guarantee session compatibility** (doc 07). Pi tolerates it, with a fallback message. Claude and OpenCode behaviour is unverified. Gate native warm-start on an engine + model + adapter-version match.
- **Steering is engine-specific.** Pi has native steer/follow-up. Claude can steer only in streaming-input mode. ACP stable cannot steer (cancel + new prompt is the only option). OpenCode over HTTP is unverified. Keep `steer` as a negotiated feature, and fix the Pi adapter before advertising it.

## Sources

- [P1] Pi docs `docs/sessions.md` (pi-coding-agent 1.4.0, installed): `--continue`, `--resume`, `/fork`, `/clone`, `--no-session`, storage `~/.pi/agent/sessions/`.
- [P2] Pi types `dist/core/session-manager.d.ts` (1.4.0): `create`, `open(path, sessionDir?, cwdOverride?)`, `continueRecent`, `inMemory`, `forkFrom`, `findById`, `branch`, `createBranchedSession`; impl `dist/core/session-manager.js:794-812, 1326-1348`.
- [P3] Pi docs `docs/sdk.md` §Prompting and §Session storage (1.4.0): steer/follow-up semantics, `AgentSessionRuntime.fork()`.
- [P4] Pi types `dist/core/agent-session.d.ts:544-587` (1.4.0): `prompt()` "@throws Error if streaming and no streamingBehavior specified", `steer()`, `followUp()`.
- [P5] Pi docs `docs/session-format.md` (1.4.0): header v3 with `cwd`, `parentSession`, `model_change` entries.
- [P6] Pi types `dist/core/sdk.d.ts:72-73`: `modelFallbackMessage`, "Warning if session was restored with a different model than saved".
- [C1] Claude Agent SDK docs, "Work with sessions": https://code.claude.com/docs/en/agent-sdk/sessions (fetched 2026-11-07): continue/resume/fork, storage path, "Same machine only", resume across hosts, fork does not branch the filesystem.
- [C2] `@anthropic-ai/claude-agent-sdk` 0.3.311 `sdk.d.ts`: `forkSession()` L842-879 ("file-history snapshots are not copied"); `enableFileCheckpointing` L1731-1739; `forkSession` option L1751-1755; `persistSession` / `sessionStore` L1856-1893; `resume`, `sessionId`, `resumeSessionAt`, `resumeDropsTurn` L2130-2198; model "restored while resuming" L2660; `interrupt()` L2937; `setModel()` L2973; `streamInput()` L3298; `SDKUserMessage.priority` L6564; `cleanupPeriodDays` default 30 L7068-7071.
- [C3] Claude Agent SDK docs, "Streaming Input": https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode (single-message mode lacks queueing and interruption).
- [O1] `opencode run --help`, `opencode session --help` (v2.2.5, local): `--continue`, `--session`, `--fork`, `--model`; `session list/delete/export/import`.
- [O2] Live probe: `opencode acp` `initialize` (protocolVersion 1) returned `agentCapabilities: {loadSession:true, sessionCapabilities:{additionalDirectories,close,delete,fork,list,resume}}`, `agentInfo.version "2.2.5"`. Probe script: a single `initialize` JSON-RPC line on stdin.
- [O3] OpenCode server docs: https://docs.opencode.ai/docs/server/ (fetched 2026-11-07; page carries no version): `POST /session/:id/fork`, `/abort`, `/prompt_async`, `/revert`, `/unrevert`. Busy-session behaviour is not documented.
- [O4] Local data dir listing `~/.local/share/opencode/` (v2.2.5): `opencode.db{,-shm,-wal}`, `snapshot/`, `storage/`, `tool-output/`.
- [A1] ACP schema method lists at tag `schema-v1.29.1`: stable https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v1.29.1/schema/v1/meta.json (no `session/fork`); unstable https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v1.29.1/schema/v1/meta.unstable.json (adds `session/fork`, `archive`, `status`, `set_title`). `ForkSessionRequest` in `schema.unstable.json` is marked "**UNSTABLE** ... may be removed or changed at any point". (Fetched from `main` on 2026-11-07, which matched the latest release tag.)
- [A2] ACP docs, Session Setup: https://agentclientprotocol.com/protocol/session-setup. `session/load` "MUST replay the entire conversation"; `session/resume` "MUST NOT replay"; clients "SHOULD send the same `systemPrompt`". Stable `SessionCapabilities` props: `list, delete, additionalDirectories, systemPrompt, resume, close`.
- [A3] `@agentclientprotocol/sdk` 2.4.0 `package.json` exports (`.` → `dist/v1/stable`, `./unstable` → `dist/v1/unstable`); `dist/v1/stable/acp.d.ts` method map has no `fork`; `dist/v1/acp.d.ts` (re-exported by `unstable`) includes `fork: "session/fork"`. https://unpkg.com/@agentclientprotocol/sdk@2.4.0/
- [A4] ACP docs, Prompt Turn: https://agentclientprotocol.com/protocol/prompt-turn (cancel is the only mid-turn control).
- [A5] ACP schema `CHANGELOG.md` (v1): "Stabilize model_config option category (#1502)".
- Repo: `apps/runner/src/engines/{pi,claude,acp,opencode}.ts`, `apps/runner/package.json`, `docs/implementation/07-harnesses-and-tools.md` (§Checkpoint, §Adapter features), `contracts/v1/library-register.json` (ACP: "Default stable protocol-v1 entrypoint").
