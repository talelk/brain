# 17 — OpenCode and local Qwen execution contract

## Selected coding environment

Use OpenCode **2.1.4**, the locally observed executable, with **`local-qwen/qwen3.8-flash-next-a5b`**. This is the user's configured local model, not Alibaba's similarly named hosted endpoint. The existing provider is inherited from the operator's global OpenCode configuration. No endpoint, API key or global configuration content is copied into this pack. OpenCode is the implementation assistant; this choice does not add another Brain runtime harness.

The declared local model limits are 262,144 context tokens and 32,768 output tokens. They are configuration claims, not measured reliable working capacity. Start with a **48,000-token working context target**, at most 6,000 tokens of tool output per call, and 16,000 recent tokens retained at compaction. Work may span many calls, packages and sessions; these are attention limits, not incremental delivery requirements. No finite agent `steps` cap is configured: OpenCode removes tools at that cap, which would prematurely end whole-system work.

The root [opencode.json](../../opencode.json) uses native v2 `agents`, `permissions`, `shell` and `subagent` fields. It explicitly loads RTK: an `@file` line in AGENTS.md alone is insufficient evidence that OpenCode loaded that file. It loads the implementation prompt and this work protocol, not the entire consolidated specification on every request. Global/project instructions combine; inspect conflicts before starting. [Configuration](https://dev.opencode.ai/v2/docs/config/), [instructions](https://dev.opencode.ai/v2/docs/instructions/), [agents](https://dev.opencode.ai/v2/docs/agents/)

## Start, preflight and continuation

1. Run `rtk python3 scripts/check_opencode_profile.py`. It checks executable version, sanitized global model metadata, project config, required instructions and source files. It never prints secrets or calls a model.
2. Run `rtk python3 scripts/implementation_context.py T01 T02` to build the initial reading packet. Read the named source files; the packet is an index, not a substitute for them. Packets are generated from the canonical work plan; each names its owning module, exact target files, verification commands, scenario IDs and literal oracle IDs. Add `--oracles` for the relevant fixed expected observations, while `--schemas` selects just the contract definitions. Use `--schemas` to retrieve only the packet's named canonical definitions instead of dumping the entire schema into context. Related task IDs may be combined freely.
3. Launch `rtk opencode run --standalone --agent brain-implementer --model local-qwen/qwen3.8-flash-next-a5b --file IMPLEMENTATION_PROMPT.md "Implement the current target. Start with the execution ledger and the dependency baseline; continue across the coverage checklist."` Alternatively start the interactive interface in this directory and select the same agent/model explicitly.
4. Record the returned session ID in the ledger. Continue with `rtk opencode run --standalone --session <recorded-id> --agent brain-implementer --model local-qwen/qwen3.8-flash-next-a5b "Read the latest checkpoint, verify the filesystem and resume the recorded next action."` Session IDs are actual values, never literal example IDs.

Do not add `--auto` as a substitute for host permissions. The supplied profile allows routine RTK shell work and normal edits; OpenCode rules are convenience controls, not an OS security boundary. Shell wildcard rules cannot prevent all destructive commands or credential reads through subprocesses. Run the assistant as the developer account inside the actual workspace restrictions. Production credentials, publishing and non-disposable data remain subject to the existing authorization. No subagents are enabled by default.

The preflight has a `--check-loader` option for the real installed OpenCode configuration loader. It runs `debug config` in isolated temporary XDG data/state/cache directories while retaining the user's existing configuration location; it captures output privately and reports only exit status and whether the project source is listed. It does not print the effective configuration. A loader failure is a setup failure, not permission to switch models silently.

## Deterministic work record

Use `artifacts/implementation/ledger.json` with the `ImplementationLedger` schema and `artifacts/implementation/checkpoint.json` with `ImplementationCheckpoint`. Samples are in `examples/v1/execution/`; initialize them for product work, rather than claiming the documentation task completed product cards. Persist via write-temp, fsync, rename; one writer owns the ledger. Never include reusable credentials, raw private prompts or complete environment dumps.

Ledger entries name all T01–T50 and G01–G08, state (`pending`, `active`, `passed`, `failed`, `blocked`), exact evidence paths and blocker/next action. `passed` requires evidence bound to the current input fingerprint. A file existing, an implementation model's self-report, a skipped suite or a green pack checker cannot satisfy a runtime gate.

Checkpoint includes the current objective, immutable policy digest, actual filesystem fingerprint, active task IDs, files owned/changed, commands in progress with process/container IDs, acceptance IDs verified, failing commands, unresolved decisions, next command and last observed session ID. Read it after compaction, process death and a new session, then recheck the files and processes before acting. A checkpoint is durable work continuity; it imposes no small-patch or deployable-intermediate-state constraint.

## Loop and error handling

For each related body of work: inspect callers and the owning contract; read the focused official API reference; implement across required modules; run the smallest meaningful oracle; fix the cause; checkpoint. Keep a visible list of remaining required behavior. Before a command likely to exceed 30 seconds, record ownership/timeout/output path; supervise it with the execution tool rather than detach and sleep-poll.

After three equivalent failures, preserve the reproduction and classify it: missing dependency, incorrect API, logic defect, environment limit, absent external credential or model/tool defect. Try a materially different evidence-based action or continue independent work. Do not use a repeated-failure counter as an excuse to declare the whole implementation complete or to broaden privileges. Do not rewrite tests to reproduce the implementation's bug.

Compaction is lossy. The checkpoint must preserve exact invariants, known failing scenarios, current path ownership and the next concrete action. Re-read policy and owning schemas after compaction. `compaction.buffer=40000` reserves space below the declared model limit; it does not enforce the smaller working-context target. Request manual compaction after checkpointing when the working target is reached. [Compaction](https://dev.opencode.ai/v2/docs/compaction/)

## Provider settings and model qualification

Retain the working global provider until its actual request path is measured. Do not replace it with a guessed hosted Qwen provider or silently disable reasoning. Tune provider-level `settings.headerTimeout`, `settings.chunkTimeout` and `settings.timeout` only through the installed v2 schema and a measured local request. Proposed bounds: 120 s response headers, 120 s inter-chunk gap, 600 s total. Sampling controls belong in the provider/model request settings actually used by that runtime; agent `request` is not currently forwarded by v2. Unsupported controls must be omitted rather than asserted effective. [Providers](https://dev.opencode.ai/v2/docs/providers/)

Run the qualification cases in [execution plan](../../contracts/v1/execution-plan.json) inside a disposable fixture workspace before entrusting long autonomous work. Cases cover strict tool JSON, sequential tool-result use, coordinated multi-file edit, recovery from a failed test, forbidden action refusal and checkpoint recovery after compaction. The harness, not the model, compares the resulting files and command history to independent expected data. Require three consecutive clean runs per case; retain failures and latency. No direct access to the user's real project is needed for qualification.

Do not claim the model is qualified until real OpenCode/provider calls pass. Network restrictions may block this test here. If they do, report the exact missing execution evidence and keep qualification `not-run`; the detailed plan is still usable, but full autonomous-execution readiness is unproven.
