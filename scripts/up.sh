#!/usr/bin/env bash
# Keyrus Brain — launch TencentDB Memory, Governor, launcher and two runners.
# Pi handles authoring agents; Claude Code handles the evaluator runner group.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${BRAIN_DATA_DIR:-/tmp/brain-data}"
RUN_DIR="${BRAIN_RUN_DIR:-/tmp/brain-run}"
PORT="${BRAIN_PORT:-3100}"
BASE_URL="http://localhost:${PORT}"
LAUNCHER_SOCKET="${BRAIN_LAUNCHER_SOCKET:-${RUN_DIR}/launcher.sock}"
RUNNERS="${BRAIN_RUNNERS:-2}"
PROFILE="${BRAIN_PROFILE:-agents}"
[[ "$RUNNERS" == "0" || "$RUNNERS" == "2" ]] || { echo "BRAIN_RUNNERS must be 0 or 2 (one Pi author and one Claude evaluator)" >&2; exit 1; }
case "$PROFILE" in
  fixture) ENGINE="fixture"; DEFAULT_GROUP="fixture-tools" ;;
  agents) ENGINE="${BRAIN_RUNNER_ENGINE:-pi}"; DEFAULT_GROUP="agents" ;;
  *) echo "BRAIN_PROFILE must be agents or fixture" >&2; exit 1 ;;
esac
RUNNER_GROUP="${BRAIN_RUNNER_GROUP:-$DEFAULT_GROUP}"
export BRAIN_RUNNER_ENGINE="$ENGINE"
export BRAIN_AUTH_REQUIRE_2FA="${BRAIN_AUTH_REQUIRE_2FA:-false}"
export BRAIN_LOCAL_MODEL_URL="${BRAIN_LOCAL_MODEL_URL:-http://tntungx10:8000/v1}"
export BRAIN_LOCAL_MODEL_ID="${BRAIN_LOCAL_MODEL_ID:-qwen3.8-flash-next-a5b}"
export BRAIN_TENCENTDB_URL="${BRAIN_TENCENTDB_URL:-http://127.0.0.1:8420}"
export BRAIN_MEMORY_UI_URL="${BRAIN_MEMORY_UI_URL:-http://127.0.0.1:8125}"
export BRAIN_ANTHROPIC_BASE_URL="${BRAIN_ANTHROPIC_BASE_URL:-http://127.0.0.1:8096/claude-code/default}"
export BRAIN_CLAUDE_MODEL="${BRAIN_CLAUDE_MODEL:-$BRAIN_LOCAL_MODEL_ID}"

mkdir -p "$RUN_DIR" "$DATA_DIR"
if [[ -n "${BRAIN_LOCAL_RUNTIME_DIR:-}" ]]; then
  [[ "$BRAIN_LOCAL_RUNTIME_DIR" == "$RUN_DIR" ]] || { echo "Local runtime directory must match BRAIN_RUN_DIR"; exit 1; }
  chmod 700 "$RUN_DIR"
fi
cd "$ROOT"

log() { printf '[brain-up] %s\n' "$*"; }

start_detached() {
  local name="$1"; shift
  local logfile="$1"; shift
  local pidfile="${RUN_DIR}/${name}.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    log "$name already running (pid $(cat "$pidfile"))"
    return 0
  fi
  setsid -f bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$pidfile" "$@" </dev/null >>"$logfile" 2>&1
  sleep 1
  log "$name started (pid $(cat "$pidfile" 2>/dev/null || echo '?'), log $logfile)"
}

if [[ "${BRAIN_TENCENTDB_MANAGED:-true}" == "true" ]]; then
  read -r BRAIN_TENCENTDB_TEAM_ID BRAIN_TENCENTDB_AGENT_ID <<< "$(pnpm exec tsx scripts/start-tencentdb.ts)"
  export BRAIN_TENCENTDB_TEAM_ID BRAIN_TENCENTDB_AGENT_ID
  export BRAIN_ANTHROPIC_API_KEY_FILE="${BRAIN_ANTHROPIC_API_KEY_FILE:-${RUN_DIR}/tencentdb-claude-user-key}"
elif ! curl -fsS --max-time 5 "${BRAIN_TENCENTDB_URL%/}/health" >/dev/null; then
  log "ERROR: TencentDB Memory Core is unavailable at $BRAIN_TENCENTDB_URL"
  exit 1
fi
log "TencentDB Memory ready at $BRAIN_TENCENTDB_URL | admin $BRAIN_MEMORY_UI_URL"

if [[ "$PROFILE" == agents && "$RUNNERS" -gt 0 ]]; then
  for selected in pi claude; do
    BRAIN_RUNNER_ENGINE="$selected" pnpm exec tsx scripts/probe-engine.ts
  done
fi

if curl -fsS --max-time 2 "${BASE_URL}/health/ready" >/dev/null 2>&1 && [[ ! -f "${RUN_DIR}/governor.pid" ]]; then
  log "ERROR: something already serves ${BASE_URL} but is not managed by this script; choose another BRAIN_PORT"
  exit 1
else
  start_detached governor "${RUN_DIR}/governor.log" \
    env BRAIN_DATA_DIR="$DATA_DIR" PORT="$PORT" BRAIN_BASE_URL="$BASE_URL" \
    BRAIN_TENCENTDB_URL="$BRAIN_TENCENTDB_URL" BRAIN_MEMORY_UI_URL="$BRAIN_MEMORY_UI_URL" \
    pnpm exec tsx apps/governor/src/main.ts
fi

for _ in $(seq 1 30); do
  curl -fsS --max-time 2 "${BASE_URL}/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS --max-time 2 "${BASE_URL}/health/ready" >/dev/null 2>&1; then
  log "ERROR: governor not ready at ${BASE_URL}/health/ready — see ${RUN_DIR}/governor.log"
  exit 1
fi
log "governor ready at $BASE_URL"

start_detached launcher "${RUN_DIR}/launcher.log" \
  env BRAIN_LAUNCHER_SOCKET="$LAUNCHER_SOCKET" \
  pnpm exec tsx apps/launcher/src/main.ts
for _ in $(seq 1 15); do [[ -S "$LAUNCHER_SOCKET" ]] && break; sleep 1; done
[[ -S "$LAUNCHER_SOCKET" ]] || { log "ERROR: launcher socket not seen at $LAUNCHER_SOCKET — see ${RUN_DIR}/launcher.log"; exit 1; }
log "launcher socket ready at $LAUNCHER_SOCKET"

if [[ -n "${BRAIN_LOCAL_RUNTIME_DIR:-}" ]]; then
  for group in agents evaluators; do
    name="runner-${group}-1"
    mkdir -p "${RUN_DIR}/${name}-state"
    chmod 700 "${RUN_DIR}" "${RUN_DIR}/${name}-state"
    start_detached "$name" "${RUN_DIR}/${name}.log" \
      env -u BRAIN_TOKEN -u BRAIN_PASSWORD -u BRAIN_ADMIN_PASSWORD -u BRAIN_ADMIN_PASSWORD_FILE -u BRAIN_ADMIN_EMAIL -u BRAIN_ADMIN_TOTP -u BRAIN_TOTP -u BRAIN_AUTH_SECRET -u BRAIN_SETUP_TOKEN -u BRAIN_CLI_STATE_DIR -u BRAIN_DATA_DIR -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
      BRAIN_GOVERNOR_URL="$BASE_URL" BRAIN_LOCAL_RUNNER=true BRAIN_RUNNER_ID="$name" \
      BRAIN_RUNNER_STATE_DIR="${RUN_DIR}/${name}-state" BRAIN_LAUNCHER_SOCKET="$LAUNCHER_SOCKET" \
      pnpm exec tsx apps/runner/src/main.ts
  done
fi

if [[ "$RUNNERS" -gt 0 ]]; then
  if ! grep -q '\"initialized\":true' <(curl -s --max-time 3 "${BASE_URL}/v1/setup/status"); then
    log "Create the organization at $BASE_URL, compile/activate the starter release, then rerun this script."
    exit 0
  fi
  BRAIN_GOVERNOR_URL="$BASE_URL" BRAIN_RUN_DIR="$RUN_DIR" BRAIN_PROFILE="$PROFILE" \
    BRAIN_RUNNER_GROUP="$RUNNER_GROUP" BRAIN_RUNNERS="$RUNNERS" BRAIN_LAUNCHER_SOCKET="$LAUNCHER_SOCKET" \
    pnpm exec tsx scripts/enroll-local-runners.ts
fi
log "stack up: governor $BASE_URL | memory admin $BRAIN_MEMORY_UI_URL | runners Pi+Claude | logs $RUN_DIR"
log "stop with: scripts/down.sh"
