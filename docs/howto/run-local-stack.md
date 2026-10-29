# Run the local stack

One host, four components: an external memory service (optional, checked only),
the Governor, the trusted sandbox launcher, and enrolled runners.

## Requirements

Linux, Node 24, pnpm 12.11.2, Python 3, Bash, curl, Docker (for sandboxed tool and
evaluator execution), and a reachable OpenAI-compatible endpoint for the Pi engine.
Claude needs its own endpoint and credential.

## Start

Use fresh directories for the current schema. Existing data is preserved; a different
schema is refused rather than migrated.

```bash
rtk pnpm install --frozen-lockfile
rtk pnpm build
rtk bash scripts/build-sandbox-images.sh

export BRAIN_DATA_DIR="$(mktemp -d /tmp/brain-data.XXXXXX)"
export BRAIN_RUN_DIR="$(mktemp -d /tmp/brain-run.XXXXXX)"
export BRAIN_CLI_STATE_DIR="$BRAIN_RUN_DIR/cli"
export BRAIN_PORT=3100
export BRAIN_GOVERNOR_URL="http://127.0.0.1:$BRAIN_PORT"
export BRAIN_PROFILE=agents          # fixture uses the disposable golden workflows
export BRAIN_RUNNER_ENGINE=pi        # pi | claude | fixture
export BRAIN_LOCAL_MODEL_URL=http://tntungx10:8000/v1
export BRAIN_LOCAL_MODEL_ID=qwen3.8-flash-next-a5b

BRAIN_RUNNERS=0 rtk bash scripts/up.sh
```

`up.sh` is idempotent per pidfile, starts components detached via `setsid`, and fails
before launching when the selected engine cannot run (`scripts/probe-engine.ts`).
With `BRAIN_RUNNERS=0` it starts only Governor and launcher so you can initialize the
organization and activate a release first (see
[compile-activate-release.md](compile-activate-release.md)). Then rerun `up.sh` with
runners enabled; enrollment reuses the private CLI session.

## Stop

```bash
rtk bash scripts/down.sh
```

Runners stop first, then the launcher, then the Governor. Each pid is verified against
its expected command line before signaling. Data and private CLI/runner state are never
touched. TencentDB, if configured, is external and left alone.

## Logs and state

| Path | Contents |
|---|---|
| `$BRAIN_RUN_DIR/governor.log` | Governor request/daemon log |
| `$BRAIN_RUN_DIR/launcher.log` | Trusted launcher sandbox lifecycle |
| `$BRAIN_RUN_DIR/runner-<group>-<n>.log` | One log per runner |
| `$BRAIN_DATA_DIR` | Governor SQLite control state and CAS bytes |

## Troubleshooting

| Symptom | Action |
|---|---|
| Port already serves something | Pick another `BRAIN_PORT`; the script refuses to hijack an unmanaged port |
| Engine preflight fails | Check the exact model ID against the endpoint; for Claude check `BRAIN_ANTHROPIC_BASE_URL` and the credential file |
| Runners never claim work | `brain doctor --workspace <id>`; check group, capabilities, engine, heartbeat on Runs → Runners |
| Launcher socket missing | Sandbox/evaluator execution fails closed; read `launcher.log`, verify `BRAIN_LAUNCHER_SOCKET` |
| Schema mismatch on existing data dir | Preserve it; start a fresh disposable directory or review the existing deployment |
