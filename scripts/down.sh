#!/usr/bin/env bash
# Keyrus Brain — stop the stack started by scripts/up.sh.
# Stops runners -> launcher -> governor using pidfiles in BRAIN_RUN_DIR.
# Each pid is verified against its expected command line before signaling.
# Data (BRAIN_DATA_DIR) and TencentDB volumes are never deleted.
set -euo pipefail

RUN_DIR="${BRAIN_RUN_DIR:-/tmp/brain-run}"
log() { printf '[brain-down] %s\n' "$*"; }

stop_one() { # name marker
  local name="$1" marker="$2"
  local pidfile="${RUN_DIR}/${name}.pid"
  if [[ ! -f "$pidfile" ]]; then
    log "$name: no pidfile, nothing to stop"
    return 0
  fi
  local pid; pid="$(cat "$pidfile")"
  if ! kill -0 "$pid" 2>/dev/null; then
    log "$name: pid $pid not running"
    rm -f "$pidfile"
    return 0
  fi
  # Safety: only signal a process whose command line matches this component.
  local cmdline; cmdline="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
  if [[ "$cmdline" != *"$marker"* ]]; then
    log "$name: pid $pid cmdline does not match '$marker' — refusing to signal"
    return 0
  fi
  # The pidfile holds the pnpm wrapper; signal the whole session it leads.
  kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
  log "$name stopped (pid $pid)"
}

# Runners first (any runner-*.pid), then launcher, then governor.
for pidfile in "${RUN_DIR}"/runner-*.pid; do
  [[ -e "$pidfile" ]] || continue
  stop_one "$(basename "$pidfile" .pid)" "apps/runner/src/main.ts"
done
stop_one launcher "apps/launcher/src/main.ts"
rm -f "${BRAIN_LAUNCHER_SOCKET:-${RUN_DIR}/launcher.sock}"
stop_one governor "apps/governor/src/main.ts"
if [[ "${BRAIN_TENCENTDB_MANAGED:-true}" == "true" ]]; then
  pnpm exec tsx scripts/start-tencentdb.ts --stop
fi

log "stack down (Brain data and TencentDB volumes preserved in ${BRAIN_DATA_DIR:-/tmp/brain-data} and Docker)"
