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
TENCENTDB_URL="${BRAIN_TENCENTDB_URL:-http://127.0.0.1:8420}"
LAUNCHER_SOCKET="${BRAIN_LAUNCHER_SOCKET:-${RUN_DIR}/launcher.sock}"
RUNNERS="${BRAIN_RUNNERS:-1}"
RUNNER_GROUP="${BRAIN_RUNNER_GROUP:-local}"

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

# 1) External memory service: check only, never managed here.
if curl -fsS --max-time 3 "${TENCENTDB_URL%/}/" >/dev/null 2>&1 || curl -s --max-time 3 -o /dev/null "${TENCENTDB_URL%/}/" 2>/dev/null; then
  log "tencentdb reachable at $TENCENTDB_URL (external service)"
else
  log "WARNING: tencentdb not reachable at $TENCENTDB_URL — memory features degraded; start it separately"
fi

# 2) Governor
if curl -fsS --max-time 2 "${BASE_URL}/health/ready" >/dev/null 2>&1 && [[ ! -f "${RUN_DIR}/governor.pid" ]]; then
  log "WARNING: something already serves ${BASE_URL} but is not managed by this script; refusing to double-start"
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

# 4) Runners (need an initialized org + admin credentials to mint tokens)
if [[ "$RUNNERS" -lt 1 ]]; then
  log "BRAIN_RUNNERS=$RUNNERS — skipping runners"
  exit 0
fi
if ! grep -q '"initialized":true' <(curl -s --max-time 3 "${BASE_URL}/v1/setup/status" 2>/dev/null); then
  log "setup not completed yet: open $BASE_URL, create the organization/admin, then rerun with BRAIN_ADMIN_EMAIL + BRAIN_ADMIN_PASSWORD_FILE to add runners"
  exit 0
fi
if [[ -z "${BRAIN_ADMIN_EMAIL:-}" || -z "${BRAIN_ADMIN_PASSWORD_FILE:-}" ]]; then
  log "BRAIN_ADMIN_EMAIL / BRAIN_ADMIN_PASSWORD_FILE not set — skipping runner enrollment"
  exit 0
fi
ADMIN_PASSWORD="$(cat "$BRAIN_ADMIN_PASSWORD_FILE")"
COOKIES="$(mktemp)"; trap 'rm -f "$COOKIES"' EXIT
if ! curl -fsS --max-time 10 -X POST "${BASE_URL}/api/auth/sign-in/email" \
      -H 'content-type: application/json' -H "origin: ${BASE_URL}" -c "$COOKIES" \
      -d "{\"email\":\"${BRAIN_ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" >/dev/null; then
  log "ERROR: admin sign-in failed; cannot mint enrollment tokens"
  exit 1
fi
for i in $(seq 1 "$RUNNERS"); do
  name="runner-${i}"
  if [[ -f "${RUN_DIR}/${name}.pid" ]] && kill -0 "$(cat "${RUN_DIR}/${name}.pid")" 2>/dev/null; then
    log "$name already running (pid $(cat "${RUN_DIR}/${name}.pid"))"
    continue
  fi
  token="$(curl -fsS --max-time 10 -b "$COOKIES" -X POST "${BASE_URL}/v1/runner-tokens" \
      -H 'content-type: application/json' -H "origin: ${BASE_URL}" \
      -d "{\"groupId\":\"${RUNNER_GROUP}\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
  start_detached "$name" "${RUN_DIR}/${name}.log" \
    env BRAIN_GOVERNOR_URL="$BASE_URL" BRAIN_RUNNER_ID="runner-${RUNNER_GROUP}-${i}" \
    BRAIN_RUNNER_STATE_DIR="${RUN_DIR}/${name}-state" BRAIN_RUNNER_ENROLL_TOKEN="$token" \
    ${BRAIN_RUNNER_CAPABILITIES:+BRAIN_RUNNER_CAPABILITIES="$BRAIN_RUNNER_CAPABILITIES"} \
    ${BRAIN_ANTHROPIC_BASE_URL:+BRAIN_ANTHROPIC_BASE_URL="$BRAIN_ANTHROPIC_BASE_URL"} \
    ${BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY:+BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY="$BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY"} \
    ${BRAIN_ANTHROPIC_API_KEY_FILE:+BRAIN_ANTHROPIC_API_KEY_FILE="$BRAIN_ANTHROPIC_API_KEY_FILE"} \
    pnpm exec tsx apps/runner/src/main.ts
done
sleep 3
for i in $(seq 1 "$RUNNERS"); do
  grep -q "connected" "${RUN_DIR}/runner-${i}.log" 2>/dev/null \
    && log "runner-${i} connected" \
    || log "WARNING: runner-${i} not connected yet — see ${RUN_DIR}/runner-${i}.log"
done

log "stack up: governor $BASE_URL | launcher $LAUNCHER_SOCKET | runners $RUNNERS | data $DATA_DIR | run state $RUN_DIR"
log "stop with: scripts/down.sh"
