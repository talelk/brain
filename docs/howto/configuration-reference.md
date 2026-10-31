# Advanced configuration reference

Run these commands from the repository checkout. Most local users should start with `pnpm brain start` and the browser setup instead.

## Advanced checkout startup


Requirements: Linux, Node 24, pnpm 12.11.2, Python 3, Bash, curl, Docker, and a reachable OpenAI-compatible model endpoint. Startup manages the pinned official TencentDB Agent Memory stack and provisions a scoped non-admin Claude credential. Use fresh directories for this current schema; existing data is preserved and a different schema is refused.

Run from this checkout:

```bash
rtk pnpm install --frozen-lockfile
rtk pnpm build
rtk bash scripts/build-sandbox-images.sh

export BRAIN_DATA_DIR="$(mktemp -d /tmp/brain-data.XXXXXX)"
export BRAIN_RUN_DIR="$(mktemp -d /tmp/brain-run.XXXXXX)"
export BRAIN_CLI_STATE_DIR="$BRAIN_RUN_DIR/cli"
export BRAIN_PORT=3100
export BRAIN_GOVERNOR_URL="http://127.0.0.1:$BRAIN_PORT"
export BRAIN_PROFILE=agents
export BRAIN_RUNNER_ENGINE=pi
export BRAIN_LOCAL_MODEL_URL=http://tntungx10:8000/v1
export BRAIN_LOCAL_MODEL_ID=qwen3.8-flash-next-a5b
export BRAIN_AUTH_REQUIRE_2FA=false

BRAIN_RUNNERS=0 rtk bash scripts/up.sh
rtk pnpm exec tsx apps/cli/src/main.ts setup --local --email operator@example.test --name Operations --org org-local --setup-token-file "$BRAIN_DATA_DIR/setup.token"
rtk pnpm exec tsx apps/cli/src/main.ts workspace create operations --slug operations
rtk pnpm exec tsx apps/cli/src/main.ts config compile examples/v1/starter-release --json
```

Replace the model URL/ID with your own endpoint when needed. Setup prompts for a password and stores its native session in the private CLI state directory. The setup token is one-use and never printed by Governor. Compile prints a release digest and **does not activate it**. Set the digest returned by compile:

```bash
export RELEASE_DIGEST='sha256:paste-the-returned-digest-here'
rtk pnpm exec tsx apps/cli/src/main.ts config inspect "$RELEASE_DIGEST"
rtk pnpm exec tsx apps/cli/src/main.ts config activate "$RELEASE_DIGEST"
rtk bash scripts/up.sh
rtk pnpm exec tsx apps/cli/src/main.ts workflow list --workspace operations
rtk pnpm exec tsx apps/cli/src/main.ts doctor --workspace operations
rtk pnpm exec tsx apps/cli/src/main.ts workflow run agent-smoke --workspace operations --input '{"message":"BRAIN_OK"}'
```

The second `up.sh` uses your CLI session to enroll exactly two runners: Pi in `agents` and Claude Code in `evaluators`. The evaluator executes the pinned Bash/Python validator inside an ephemeral Docker sandbox on the Claude-provisioned runner. Startup verifies Memory Core, Panel, Proxy and both engines; it fails without falling back to local memory or fixture runners. `doctor` returns nonzero when the release or capable runner placement is missing; its smoke check remains unverified until an independently accepted smoke run exists.

Open `http://localhost:3100`, sign in, and choose the workspace. Work → Overview shows the setup checklist. Agents shows pinned instructions, engine requirements and limits. Workflows shows dependencies, runner groups, input fields, and expected output. Dispatch navigates to the durable run, where Summary shows structured outputs, Timeline shows engine events, and Evidence shows the independent verdict and artifact links.

Run useful workflows through either the schema-driven UI or CLI:

```bash
rtk pnpm exec tsx apps/cli/src/main.ts workflow run operations-triage --workspace operations --input '{"situation":"Error rates rose after a deployment; no rollback has been attempted."}'
rtk pnpm exec tsx apps/cli/src/main.ts workflow run support-draft --workspace operations --input '{"title":"Unable to sign in","body":"I see an expired session error."}'
```

The support response is a draft only. No workflow sends it. Approval decisions remain exact and one-use in both identity modes; authors cannot approve their own effects.

Stop the processes with the same exported directories:

```bash
rtk bash scripts/down.sh
```

Governor logs are in `$BRAIN_RUN_DIR/governor.log`; launcher logs are in `launcher.log`; each runner has `runner-<group>-<number>.log`. Stop preserves data and private runner/CLI state. Remove disposable test directories only after stopping and reviewing the evidence. Never reset an existing data directory to work around a schema error.

## How-to guides

Task-oriented guides live under [`./`](./): running the local stack, compiling and activating releases, adding governed tools, operating runs and approvals, backup/restore, the operational proof, and the reference deployment topology.

## Configuration

| Variable | Purpose / default |
|---|---|
| `BRAIN_PROFILE` | `agents` by default; `fixture` uses the disposable golden tool workflows instead of model agents |
| `BRAIN_DATA_DIR`, `BRAIN_RUN_DIR` | Governor state and process logs/pidfiles; script defaults `/tmp/brain-data`, `/tmp/brain-run` |
| `BRAIN_PORT`, `BRAIN_GOVERNOR_URL` | Script port `3100`; set the CLI URL explicitly (CLI default is `http://127.0.0.1:3000`) |
| `BRAIN_BASE_URL` | Public origin for native auth and mutation-origin checks; `up.sh` sets its local origin |
| `BRAIN_CLI_STATE_DIR` | Private native-session storage; set consistently for setup/login and startup |
| `BRAIN_RUNNERS` | `2` by default for one Pi author and one Claude evaluator; `0` starts Governor/launcher and, with local runtime setup, two waiting runners |
| `BRAIN_RUNNER_GROUP`, `BRAIN_RUNNER_CAPABILITIES` | Author group override and observed host capabilities |
| `BRAIN_RUNNER_ENGINE` | Author engine, default `pi`; evaluator enrollment selects `claude`; `fixture` is limited to the fixture profile |
| `BRAIN_LOCAL_MODEL_URL`, `BRAIN_LOCAL_MODEL_ID` | Shared local model endpoint and exact model ID; local defaults shown above |
| `BRAIN_PI_AGENT_DIR` | Private Pi session/checkpoint directory; verification uses a disposable directory |
| `BRAIN_ANTHROPIC_BASE_URL`, `BRAIN_CLAUDE_MODEL` | Claude proxy endpoint and model; defaults to TencentDB Proxy and the local model |
| `BRAIN_ANTHROPIC_API_KEY_FILE` | Preferred Claude credential file, private mode `0600`; startup supplies the scoped TencentDB business key |
| `BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY=1` | Explicit opt-in for a trusted local Anthropic-compatible endpoint; never a remote credential fallback |
| `BRAIN_AUTH_REQUIRE_2FA` | `false` by default; `true` requires enrollment and TOTP approval step-up |
| `BRAIN_AUTH_SECRET` | Optional private auth secret; otherwise Governor generates and retains its private key material |
| `BRAIN_MEMORY_UI_URL` | TencentDB Panel link, default `http://127.0.0.1:8125`; opened without forwarding credentials |
| `BRAIN_AUTH_TRUSTED_PROXIES` | Optional comma-separated trusted proxy IPs/CIDRs used for Better Auth rate-limit client IP resolution; proxy must sanitize forwarded headers |
| `BRAIN_TENCENTDB_URL`, `BRAIN_TENCENTDB_API_KEY` | Memory Core URL, default `http://127.0.0.1:8420`; non-loopback URLs require an explicit credential |
| `BRAIN_TENCENTDB_MANAGED`, `BRAIN_TENCENTDB_CHECKOUT`, `BRAIN_TENCENTDB_REVISION` | Official stack management defaults `true`, a private instance checkout, and pinned revision `ecc01a545da0b2ac6cae2f0f0af0d39d41469793` |
| `BRAIN_LAUNCHER_SOCKET`, `BRAIN_LAUNCHER_TOKEN_FILE` | Trusted launcher socket and private bearer-token file; the token file defaults to `<socket>.token` |
| `BRAIN_LAUNCHER_IMAGE_DIGESTS` | Optional reviewed digest pins for the preinstalled sandbox images |
| `BRAIN_ADMIN_EMAIL`, `BRAIN_ADMIN_PASSWORD` | Initial local administrator credentials; defaults `admin@brain.local` / `admin-password`, with no forced change. Set a private override before exposing Governor |
| `BRAIN_ADMIN_PASSWORD_FILE`, `BRAIN_ADMIN_TOTP` | Optional unattended runner-enrollment login; password file must be owned and private; otherwise use `brain login` first |

With required 2FA, enroll in the UI and use `brain login` to complete native TOTP sign-in before enrolling runners. Settings → Security offers voluntary enrollment/disable in optional mode. Recovery sign-in requires replacing the previous authenticator before approval evidence can be issued. External administration links open separately with `noopener noreferrer`; Brain forwards no credentials.

`docker-compose.yml` passes the security and integration variables to Governor. The reference deployment files describe the separate runner/launcher trust boundary. Do not expose local plaintext HTTP or the launcher socket to an untrusted network.

## Author agents and workflows

Start from `examples/v1/starter-release/`. A complete release contains:

- `config/*.yaml`: Agents, Workflows, policies, evaluator/tool definitions, runner groups and workspace declarations.
- `agents/*.md`: instruction bytes named by each Agent's confined `instructionsPath`.
- `schemas/*.json`: confined JSON schemas referenced by workflow/tool inputs and outputs; network schema references are rejected.
- `tools/<tool-id>/<entrypoint>`: the declared tool script; executable bytes are pinned and fetched through the authenticated runner protocol.

An Agent declares its permitted engines/features, immutable tool references, and turn/token/cost/child/depth limits. The Operations Assistant allowlists only the read-only `operations.context` release; the other starter agents have empty allowlists. The two starter task agents have 8192-token budgets; the internal task guide has 16384. All use zero-cost local-model budgets. Set an explicit `maxMicroUsd` in the Agent document before selecting a paid provider, then update its immutable workflow reference. Pi and Claude native host tools stay disabled; only release-pinned custom tools may cross the broker, which validates schemas, targets, digests, budgets and permits before sandboxed execution. Uninstalled or unauthorized bindings fail explicitly.

Workflows bind input fields to jobs and refer to Agent/Evaluator documents by SHA-256 of their exact document bytes. After editing an Agent, Tool or Evaluator, update its referring documents' digests. `brain config compile` collects declared assets, rejects missing instructions/schemas and bad references, and stages an immutable manifest. It uses the collected bundle's content digest as the source revision unless you supply `--source-revision sha1:<git-commit>` or `sha256:<source-digest>`. Inspect the exact manifest, then activate separately. Activation checks the observed active digest; a concurrent change requires another inspection.

Workflow input validation happens before a command is durably accepted. Model outputs must match the pinned output schema and pass the separate deterministic validator. A model completion, runner exit, or successful stream alone cannot make the workflow succeed. The shipped L1 evaluator requires a different attempt; it does not attest a separate physical host. Production trust-domain verification and stronger independence are separate policy choices.

## Verification and troubleshooting

```bash
rtk pnpm verify:full
rtk python3 scripts/generate_contract_types.py --check
rtk python3 scripts/generate_implementation_indexes.py --check
rtk python3 scripts/verify_implementation_pack.py
rtk bash examples/v1/starter-release/tools/operations.validate/test.sh
rtk bash scripts/verify-operational.sh
```

The operational proof uses a real socket, real native setup/CLI compile/activation, Pi, actual output uploads, a trusted launcher, Docker validation, and all four user/diagnostic starter workflows in disposable directories. It fails rather than skipping if its model or Docker image is unavailable. Evidence goes to `artifacts/implementation/operational-<timestamp>/`; set `BRAIN_OPERATIONAL_EVIDENCE_DIR` to choose a path, or `BRAIN_OPERATIONAL_ENGINE=claude` to explicitly test Claude authoring. Records include source fingerprints, engine/model IDs, commands, run/attempt/evidence IDs, output digests, and model events. Browser workflows use the deterministic fixture engine; they establish UI behavior separately from live model proof.

| Symptom | Action |
|---|---|
| No active release / no catalog | Compile the complete directory, inspect its digest, activate it; re-read the checklist |
| Dispatch input rejected | Follow the workflow's required fields; the UI retains values so you can correct them |
| Waiting for a runner | Check group, capabilities, engine features, current heartbeat and free capacity with `doctor` and Runs → Runners |
| Engine preflight unavailable | Check the exact model ID against the configured endpoint; check Claude's credential file and endpoint policy |
| Validator tool fails | Build the sandbox images; inspect launcher and evaluator logs; images must contain Bash and Python |
| Approval needs identity verification | Use a current native session; required mode also needs TOTP; replaced/revoked sessions or membership invalidate evidence |
| Existing schema refused | Preserve that directory. Use a fresh disposable directory for this target build or stop and review the existing deployment |
| Memory degraded / no link | Inspect the managed TencentDB containers and Model/Proxy configuration; startup does not silently substitute local memory |
| Uncertain effect outcome | Reconcile the recorded target state before any retry; do not blindly dispatch again |

Live customer connectors, production credentials, semantic/model-quality evaluation, complete remote TencentDB restore, and independent third-party release certification remain outside this operational proof. The browser suite checks responsive behavior and core accessibility; it is not a formal WCAG audit.
