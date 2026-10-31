# Run the local stack

One host runs the official TencentDB Agent Memory stack, Governor, trusted sandbox
launcher, and two enrolled runners: Pi for authoring and Claude Code for evaluation.

## Requirements

Linux, Node 24, pnpm 12.11.2, Python 3, Bash, curl, Docker (for memory and sandboxed
execution), and a reachable OpenAI-compatible model endpoint. Startup uses the pinned
official TencentDB deployment scripts and creates a scoped non-admin Claude identity.

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
export BRAIN_PROFILE=agents
export BRAIN_LOCAL_MODEL_URL=http://tntungx10:8000/v1
export BRAIN_LOCAL_MODEL_ID=qwen3.8-flash-next-a5b

BRAIN_RUNNERS=0 rtk bash scripts/up.sh
```

`up.sh` starts components detached via `setsid`. It starts Memory Core on `8420`,
Knowledge on `8424`, Panel on `8125`, and Proxy on `8096`; verifies the model and
service health; then starts Governor and the launcher. With `BRAIN_RUNNERS=0`, runner
enrollment waits until the organization and release exist (see
[compile-activate-release.md](compile-activate-release.md)). Rerun `up.sh` with the
default `BRAIN_RUNNERS=2` to enroll Pi in `agents` and Claude in `evaluators`.
Startup fails without using local memory or fixture runners as a fallback.

Open **http://localhost:8125** for TencentDB Memory administration. Brain's
Administration → Integrations link opens the same UI without forwarding credentials.

## Stop

```bash
rtk bash scripts/down.sh
```

Runners stop first, then the launcher, Governor, and managed TencentDB containers.
Each Brain pid is verified against its expected command line before signaling. Brain
data, private CLI/runner state, TencentDB volumes, and the admin credential are preserved.

## Logs and state

| Path | Contents |
|---|---|
| `$BRAIN_RUN_DIR/governor.log` | Governor request/daemon log |
| `$BRAIN_RUN_DIR/launcher.log` | Trusted launcher sandbox lifecycle |
| `$BRAIN_RUN_DIR/runner-<group>-<n>.log` | One log per runner |
| `$BRAIN_RUN_DIR/tencentdb-binding.json` | Non-secret team/agent binding for Claude |
| `$BRAIN_RUN_DIR/tencentdb-claude-user-key` | Private scoped TencentDB business credential |
| `$BRAIN_DATA_DIR` | Governor SQLite control state and CAS bytes |

Use `docker logs tdai-memory-core`, `docker logs tdai-memory-hub`, or
`docker logs tdai-proxy` for memory service diagnostics. Do not print credential files.

## Troubleshooting

| Symptom | Action |
|---|---|
| Port already serves something | Pick another `BRAIN_PORT`; the script refuses to hijack an unmanaged Governor port; change TencentDB ports in its private deployment `.env` |
| Memory or engine preflight fails | Check the exact model ID and endpoint; inspect the official containers and the scoped Claude credential/binding |
| Runners never claim work | `brain doctor --workspace <id>`; check group, capabilities, engine, heartbeat on Runs → Runners |
| Launcher socket missing | Sandbox/evaluator execution fails closed; read `launcher.log`, verify `BRAIN_LAUNCHER_SOCKET` |
| Schema mismatch on existing data dir | Preserve it; start a fresh disposable directory or review the existing deployment |
