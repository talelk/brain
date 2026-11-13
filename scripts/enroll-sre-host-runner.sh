#!/usr/bin/env bash
# Enrol the privileged `sre-host` runner on the demo server (the only runner that may hold host tools, ADR 0024).
# 1. In Brain: Administration > Runners > Enroll runner, group `sre-host`, "Issue one-use token" (valid ten minutes), copy the token.
# 2. Put it in ~/.cache/sre-token (or BRAIN_SRE_RUNNER_TOKEN_FILE) and run scripts/enroll-sre-host-runner.sh; the file is deleted afterwards.
# The token goes to the server over ssh stdin into a 0600 env file; it is never printed. Restartable containers are NOT enabled here:
# the allow-list is empty until `BRAIN_SRE_RESTARTABLE=<names> scripts/provision-sre-demos.sh` names them.
set -euo pipefail
cd "$(dirname "$0")/.."
TOKEN_FILE="${BRAIN_SRE_RUNNER_TOKEN_FILE:-$HOME/.cache/sre-token}"
if [ -z "${BRAIN_SRE_RUNNER_TOKEN:-}" ] && [ -r "$TOKEN_FILE" ]; then BRAIN_SRE_RUNNER_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"; fi
: "${BRAIN_SRE_RUNNER_TOKEN:?set BRAIN_SRE_RUNNER_TOKEN, or put the token in $TOKEN_FILE}"
set -a; . "${BRAIN_DEV_CREDENTIALS:-$HOME/.config/brain-dev/credentials.env}"; set +a
HOST="${BRAIN_DEPLOY_HOST:-ns390729}"; PORT="${BRAIN_DEPLOY_PORT:-42242}"; R="${BRAIN_DEPLOY_DIR:-/srv/demos/brain}"
SSH=(ssh -p "$PORT" -o ConnectTimeout=15 "talel@$HOST")
SUDO="printf '%s\n' $(printf '%q' "$BRAIN_DEPLOY_SUDO_PASSWORD") | sudo -S -p ''"
"${SSH[@]}" "test -f $R/runner-agents.env"
# env file: the agents runner's, with its own identity, one slot, host.read mounted, and the token set
"${SSH[@]}" "cd $R && cp -n runner-agents.env runner-sre-host.env && chmod 600 runner-sre-host.env
  up() { if grep -q \"^\$1=\" runner-sre-host.env; then sed -i \"s|^\$1=.*|\$1=\$2|\" runner-sre-host.env; else echo \"\$1=\$2\" >> runner-sre-host.env; fi; }
  up BRAIN_RUNNER_ID runner-sre-host-1; up BRAIN_RUNNER_STATE_DIR $R/runner-sre-host-state; up BRAIN_RUNNER_SLOTS 1; up BRAIN_TOOL_DATA_MOUNTS host.read=srv
  sed -i '/^BRAIN_RUNNER_ENROLL_TOKEN=/d' runner-sre-host.env"
printf 'BRAIN_RUNNER_ENROLL_TOKEN=%s\n' "$BRAIN_SRE_RUNNER_TOKEN" | "${SSH[@]}" "cat >> $R/runner-sre-host.env"
"${SSH[@]}" "sed 's|runner-agents.env|runner-sre-host.env|; s|(agents group, Pi engine)|(sre-host group, host tools, Pi engine)|' /etc/systemd/system/brain-runner-agents.service > /tmp/brain-runner-sre-host.service && $SUDO cp /tmp/brain-runner-sre-host.service /etc/systemd/system/ && $SUDO systemctl daemon-reload && $SUDO systemctl enable brain-runner-sre-host >/dev/null 2>&1; $SUDO systemctl restart brain-runner-sre-host"
# host tools exist only on this runner: take the host.read mount off the agents runner
"${SSH[@]}" "sed -i '/^BRAIN_TOOL_DATA_MOUNTS=/d' $R/runner-agents.env && $SUDO systemctl restart brain-runner-agents"
sleep 12
"${SSH[@]}" "systemctl is-active brain-runner-sre-host; tail -n 3 \$(ls -t $R/runner-sre-host-state/*.log 2>/dev/null | head -1) 2>/dev/null || journalctl -u brain-runner-sre-host -n 5 --no-pager | cut -c1-200"
rm -f "$TOKEN_FILE"
echo "==> done: check Administration > Runners for runner-sre-host-1 (group sre-host)"
