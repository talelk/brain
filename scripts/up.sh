#!/usr/bin/env bash
# Keyrus Brain — launch the full local stack:
#   TencentDB (external, checked) -> Governor -> sandbox launcher -> runner(s)
#
# Idempotent: components already running (per pidfile) are left alone.
# Detached via setsid so services survive the launching shell/session.
#
# Configuration (environment):
#   BRAIN_DATA_DIR        Governor data dir        (default /tmp/brain-data)
#   BRAIN_RUN_DIR         pidfiles + logs          (default /tmp/brain-run)
#   BRAIN_PORT            Governor port            (default 3100)
#   BRAIN_TENCENTDB_URL   memory service URL       (default http://127.0.0.1:8420)
#   BRAIN_LAUNCHER_SOCKET launcher unix socket     (default $BRAIN_RUN_DIR/launcher.sock)
#   BRAIN_RUNNERS         number of runners        (default 1)
#   BRAIN_RUNNER_GROUP    runner group id          (default local)
#   BRAIN_RUNNER_CAPABILITIES  capability csv      (default: runner built-in)
#   BRAIN_ADMIN_EMAIL     admin email for minting enrollment tokens
#   BRAIN_ADMIN_PASSWORD_FILE  file with admin password (mode 0600)
#   BRAIN_ANTHROPIC_BASE_URL / BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY / BRAIN_ANTHROPIC_API_KEY_FILE
#                         passed through to runners for the Claude engine
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${BRAIN_DATA_DIR:-/tmp/brain-data}"
RUN_DIR="${BRAIN_RUN_DIR:-/tmp/brain-run}"
PORT="${BRAIN_PORT:-3100}"
BASE_URL="http://127.0.0.1:${PORT}"
TENCENTDB_URL="${BRAIN_TENCENTDB_URL:-}"
LAUNCHER_SOCKET="${BRAIN_LAUNCHER_SOCKET:-${RUN_DIR}/launcher.sock}"
RUNNERS="${BRAIN_RUNNERS:-1}"
PROFILE="${BRAIN_PROFILE:-agents}"
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

mkdir -p "$RUN_DIR" "$DATA_DIR"
cd "$ROOT"

log() { printf '[brain-up] %s\n' "$*"; }

start_detached() { # name logfile -- command...
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

# Fail before starting processes when a selected real engine cannot run.
if [[ "$PROFILE" == agents && "$RUNNERS" -gt 0 ]]; then
  pnpm exec tsx scripts/probe-engine.ts
fi

# 1) External memory service: check only, never managed here.
if [[ -z "$TENCENTDB_URL" ]]; then
  log "using local memory; no external TencentDB configured"
elif curl -fsS --max-time 3 "${TENCENTDB_URL%/}/" >/dev/null 2>&1 || curl -s --max-time 3 -o /dev/null "${TENCENTDB_URL%/}/" 2>/dev/null; then
  log "tencentdb reachable at $TENCENTDB_URL (external service)"
else
  log "WARNING: tencentdb not reachable at $TENCENTDB_URL — memory features degraded; start it separately"
fi

# 2) Governor
if curl -fsS --max-time 2 "${BASE_URL}/health/ready" >/dev/null 2>&1 && [[ ! -f "${RUN_DIR}/governor.pid" ]]; then
  log "ERROR: something already serves ${BASE_URL} but is not managed by this script; choose another BRAIN_PORT"
  exit 1
else
  start_detached governor "${RUN_DIR}/governor.log" \
    env BRAIN_DATA_DIR="$DATA_DIR" PORT="$PORT" BRAIN_BASE_URL="$BASE_URL" BRAIN_TENCENTDB_URL="$TENCENTDB_URL" \
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

# 3) Sandbox launcher (trusted, unix socket)
start_detached launcher "${RUN_DIR}/launcher.log" \
  env BRAIN_LAUNCHER_SOCKET="$LAUNCHER_SOCKET" \
  pnpm exec tsx apps/launcher/src/main.ts
for _ in $(seq 1 15); do [[ -S "$LAUNCHER_SOCKET" ]] && break; sleep 1; done
[[ -S "$LAUNCHER_SOCKET" ]] && log "launcher socket ready at $LAUNCHER_SOCKET" \
  || log "WARNING: launcher socket not seen at $LAUNCHER_SOCKET — see ${RUN_DIR}/launcher.log"

# 4) Runners use the same private CLI session as the operator. An explicit
# private password-file login is also supported for unattended local startup.
if [[ "$RUNNERS" -gt 0 ]]; then
  if ! grep -q '\"initialized\":true' <(curl -s --max-time 3 "${BASE_URL}/v1/setup/status"); then
    log "Create the organization at $BASE_URL (or with brain setup), compile/activate the starter release, then rerun this script."
    exit 0
  fi
  BRAIN_GOVERNOR_URL="$BASE_URL" BRAIN_RUN_DIR="$RUN_DIR" BRAIN_PROFILE="$PROFILE" \
    BRAIN_RUNNER_GROUP="$RUNNER_GROUP" BRAIN_RUNNERS="$RUNNERS" BRAIN_LAUNCHER_SOCKET="$LAUNCHER_SOCKET" \
    pnpm exec tsx scripts/enroll-local-runners.ts
fi
log "stack up: governor $BASE_URL | launcher $LAUNCHER_SOCKET | data $DATA_DIR | logs $RUN_DIR"
log "stop with: scripts/down.sh"
