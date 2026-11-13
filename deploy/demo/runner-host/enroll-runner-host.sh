#!/usr/bin/env bash
# Prepares a SECOND (or third) runner host: writes the runner's environment file and systemd unit for one runner of one group.
# Run it ON the new host from a checkout of this repository, after an administrator created an enrollment token for the group
# (`brain runner token create --group agents`, or POST /v1/runner-tokens) and saved it to a private file on this host.
#   enroll-runner-host.sh --governor-url https://brain.example --token-file ~/runner.token --id runner-agents-2 --group agents \
#       [--engine pi|claude] [--slots 3] [--host-label beta] [--out /srv/brain-runner] [--checkout /srv/brain-runner/src]
# It writes <out>/<id>.env (mode 0600) and <out>/brain-runner-<id>.service, prints what to do next, and never prints the token. It
# changes nothing else: installing the unit and starting it is a separate, visible step. The Governor URL must be https (loopback http
# is allowed for development): the token and every runner request cross the network.
set -euo pipefail
GOVERNOR_URL=""; TOKEN_FILE=""; ID=""; GROUP=""; ENGINE="pi"; SLOTS="3"; LABEL=""; OUT="/srv/brain-runner"; CHECKOUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --governor-url) GOVERNOR_URL="$2"; shift 2 ;;
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --id) ID="$2"; shift 2 ;;
    --group) GROUP="$2"; shift 2 ;;
    --engine) ENGINE="$2"; shift 2 ;;
    --slots) SLOTS="$2"; shift 2 ;;
    --host-label) LABEL="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --checkout) CHECKOUT="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
fail() { echo "enroll-runner-host: $*" >&2; exit 1; }
[ -n "$GOVERNOR_URL" ] && [ -n "$TOKEN_FILE" ] && [ -n "$ID" ] && [ -n "$GROUP" ] || fail "--governor-url, --token-file, --id and --group are required"
case "$GOVERNOR_URL" in https://*|http://127.0.0.1*|http://localhost*) ;; *) fail "the Governor URL must be https (loopback http is for development only)" ;; esac
[[ "$ID" =~ ^[a-z][a-z0-9-]{1,62}$ ]] || fail "--id must be lowercase letters, digits and dashes"
[[ "$GROUP" =~ ^[a-z][a-z0-9.-]{0,63}$ ]] || fail "--group must be a runner group id"
[[ "$SLOTS" =~ ^[1-9][0-9]*$ ]] || fail "--slots must be a positive integer"
[ "$ENGINE" = pi ] || [ "$ENGINE" = claude ] || fail "--engine must be pi or claude"
[ -f "$TOKEN_FILE" ] || fail "token file not found"
[ "$(stat -c %a "$TOKEN_FILE")" = 600 ] || fail "the token file must have mode 0600"
[ -s "$TOKEN_FILE" ] || fail "the token file is empty"
LABEL="${LABEL:-$(hostname -s | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n-' '-')}"
CHECKOUT="${CHECKOUT:-$OUT/src}"
mkdir -p "$OUT/state/$ID"; chmod 700 "$OUT"

umask 077
# The enrollment token is copied into the private env file (mode 0600), as the existing units do; a token enrolls one runner, which then
# keeps its own credential in its state directory.
{
  echo "BRAIN_GOVERNOR_URL=$GOVERNOR_URL"
  echo "BRAIN_LAUNCHER_SOCKET=$OUT/run/launcher.sock"
  echo "BRAIN_RUNNER_STATE_DIR=$OUT/state/$ID"
  echo "BRAIN_RUNNER_ID=$ID"
  echo "BRAIN_RUNNER_ENGINE=$ENGINE"
  echo "BRAIN_RUNNER_SLOTS=$SLOTS"
  echo "BRAIN_RUNNER_CAPABILITIES=os:linux,arch:amd64,tool:bash,tool:python3,isolation:ephemeral-container,host:$LABEL"
  echo "BRAIN_RUNNER_ENROLL_TOKEN=$(tr -d '\n' < "$TOKEN_FILE")"
} > "$OUT/$ID.env"
chmod 600 "$OUT/$ID.env"
cat > "$OUT/brain-runner-$ID.service" <<UNIT
[Unit]
Description=Keyrus Brain runner $ID (group $GROUP, host $LABEL)
After=network-online.target brain-launcher.service
Wants=brain-launcher.service

[Service]
WorkingDirectory=$CHECKOUT
EnvironmentFile=$OUT/$ID.env
ExecStart=/usr/bin/pnpm exec tsx apps/runner/src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
cat <<NEXT
Prepared runner $ID for group $GROUP on host $LABEL (not installed, not started).
  env file  : $OUT/$ID.env (private)
  unit file : $OUT/brain-runner-$ID.service
Next, on this host:
  1. Put the same version of this repository at $CHECKOUT and run: pnpm install --frozen-lockfile
  2. Make sure the trusted launcher runs here with its socket at $OUT/run/launcher.sock (see docs/howto/deploy-compose.md).
  3. sudo cp $OUT/brain-runner-$ID.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now brain-runner-$ID
  4. Watch Health in Brain: "runners" should show the new total of slots. Then delete the token file.
NEXT
