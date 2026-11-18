#!/usr/bin/env bash
# Deploys this checkout to the demo host: the Governor in a container behind the host's nginx, and on the host itself the
# launcher, one runner, the egress proxy and the backup timers.
#
#   scripts/deploy-demo.sh             deploy
#   scripts/deploy-demo.sh --dry-run   print every action, local and remote, and do none of them: no connection is made, no
#                                      credential is read
#
# Layout on the host, under /srv/demos/brain:
#   src/                 this repository (rsync; nothing else is ever synced)
#   data/                the Governor's data, mounted into its container; `pnpm brain backup` reads it from the host
#   run/                 launcher socket, the runner's folder, egress grants, the Governor's runner token
#   archive/             what earlier versions left: data-<time>/, config-<time>/. Never deleted by any deploy.
#   docker-compose.yml, .env, runner.env, host-commands.json     written by this script
#
# Steps, in order:
#   1. Once, before the first deploy of this version (no /srv/demos/brain/.simplified-model yet): stop and disable the units
#      of the earlier stack that no longer exist, stop the earlier Governor, MOVE data/ to archive/data-<time>/ (data kept
#      in the earlier stack's Docker volume is copied there instead, and the volume is left as it is), move the earlier
#      run/ and configuration to archive/config-<time>/, and make an empty data/. Nothing is deleted.
#   2. Sync the source.
#   3. Install docker-compose.yml, .env and host-commands.json (the host commands of the `sre` pack).
#   4. Build the Governor image and the sandbox images.
#   5. Start the Governor and wait for /health/ready.
#   6. Start the egress proxy, the only way a sandbox reaches a network.
#   7. Node and the dependencies of the launcher and the runner on the host.
#   8. The systemd units brain-launcher and brain-runner; the runner enrols by itself the first time, with the token the
#      Governor leaves while it has no runner.
#   9. The backup timers, when /srv/demos/brain/backup.env exists.
#  10. Checks, and on a fresh install the setup link.
# Attempts that are running when the Governor or the runner restarts are taken back and run again.
#
# Environment:
#   BRAIN_DEPLOY_HOST (demos.mykeyrus.tn)  BRAIN_DEPLOY_PORT (42242)  BRAIN_DEPLOY_USER (talel)  BRAIN_DEPLOY_DIR (/srv/demos/brain)
#   BRAIN_DEPLOY_SUDO_PASSWORD   the deploy user's sudo password; never stored in the repository
#   BRAIN_DEMO_DOMAIN (brain.mykeyrus.tn)
#   BRAIN_DEPLOY_ENGINES (pi,claude)  BRAIN_DEPLOY_RUNNER_SLOTS (3)
#   BRAIN_DEPLOY_SANDBOX_CPU_MILLICORES (2000)  BRAIN_DEPLOY_SANDBOX_MEMORY_MB (4096)
set -euo pipefail

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    *) echo "usage: scripts/deploy-demo.sh [--dry-run]" >&2; exit 2 ;;
  esac
done

# A dev machine keeps the deploy host, port and sudo password in a private file. A dry run reads no credential.
if [ "$DRY" != 1 ] && [ -z "${BRAIN_DEPLOY_SUDO_PASSWORD:-}" ] && [ -r "$HOME/.config/brain-dev/credentials.env" ]; then
  set -a; . "$HOME/.config/brain-dev/credentials.env"; set +a
fi

HOST="${BRAIN_DEPLOY_HOST:-demos.mykeyrus.tn}"
PORT="${BRAIN_DEPLOY_PORT:-42242}"
USER_SSH="${BRAIN_DEPLOY_USER:-talel}"
REMOTE_DIR="${BRAIN_DEPLOY_DIR:-/srv/demos/brain}"
DOMAIN="${BRAIN_DEMO_DOMAIN:-brain.mykeyrus.tn}"
ENGINES="${BRAIN_DEPLOY_ENGINES:-pi,claude}"
SLOTS="${BRAIN_DEPLOY_RUNNER_SLOTS:-3}"
SANDBOX_CPU="${BRAIN_DEPLOY_SANDBOX_CPU_MILLICORES:-2000}"
SANDBOX_MEMORY="${BRAIN_DEPLOY_SANDBOX_MEMORY_MB:-4096}"
TARGET="$USER_SSH@$HOST"

for value in "$PORT" "$SLOTS" "$SANDBOX_CPU" "$SANDBOX_MEMORY"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "the port, the slots and the sandbox limits must be positive integers" >&2; exit 1; }
done
[[ "$REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ && "$DOMAIN" =~ ^[a-z0-9.-]+$ && "$ENGINES" =~ ^[a-z,]+$ && "$USER_SSH" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "the deploy directory, the domain, the engines or the user is not written as expected" >&2; exit 1; }

cd "$(dirname "$0")/.."
if [ "$DRY" = 1 ]; then
  SUDO_PASSWORD="<the sudo password>"
  echo "DRY RUN: nothing below is done. It is what a deploy to $TARGET (port $PORT), directory $REMOTE_DIR, would do."
else
  command -v rsync >/dev/null || { echo "rsync is required" >&2; exit 1; }
  : "${BRAIN_DEPLOY_SUDO_PASSWORD:?set BRAIN_DEPLOY_SUDO_PASSWORD to the sudo password of the deploy user}"
  SUDO_PASSWORD="$BRAIN_DEPLOY_SUDO_PASSWORD"
fi

# What every script run on the host starts with. The sudo password travels in the script, on the connection's standard input:
# it is never in a command line, on either machine, and never in a file.
prelude() {
  printf 'set -euo pipefail\n'
  printf 'REMOTE_DIR=%q DOMAIN=%q DEPLOY_USER=%q ENGINES=%q SLOTS=%q SANDBOX_CPU=%q SANDBOX_MEMORY=%q\n' "$REMOTE_DIR" "$DOMAIN" "$USER_SSH" "$ENGINES" "$SLOTS" "$SANDBOX_CPU" "$SANDBOX_MEMORY"
  printf 'SUDO_PASSWORD=%q\n' "$SUDO_PASSWORD"
  printf 'as_root() { sudo -k -S -p "" "$@" <<<"$SUDO_PASSWORD"; }\n'
}

# on_host "what it does" <<'SCRIPT' ... SCRIPT     runs the script on the host, or prints it in a dry run.
# The script is one group with no standard input, so the host's shell has read all of it before any command of it could.
on_host() {
  local body
  body="$(cat)"
  echo "==> $1"
  if [ "$DRY" = 1 ]; then
    { prelude; printf '{\n%s\n} </dev/null\n' "$body"; } | sed "s/^/    [on $HOST] /"
    return 0
  fi
  { prelude; printf '{\n%s\n} </dev/null\n' "$body"; } | ssh -p "$PORT" -o ConnectTimeout=15 "$TARGET" 'bash -s'
}

# locally "what it does" command...     runs a command on this machine, or prints it in a dry run.
locally() {
  echo "==> $1"
  shift
  if [ "$DRY" = 1 ]; then
    printf '    [here]'; printf ' %q' "$@"; printf '\n'
    return 0
  fi
  "$@"
}

# ---- 1. once, before the first deploy of this version: archive what the earlier version left, and start empty ----
on_host "Before the first deploy of this version: archive the earlier data (moved, never deleted) and retire the earlier units" <<'SCRIPT'
MARK="$REMOTE_DIR/.simplified-model"
mkdir -p "$REMOTE_DIR"
if [ -e "$MARK" ]; then
  echo "    already done on $(cat "$MARK"): nothing is archived, data/ is kept as it is"
else
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  ARCHIVE="$REMOTE_DIR/archive"
  mkdir -p "$ARCHIVE"
  chmod 700 "$ARCHIVE"

  # Units of the earlier stack that this version does not have.
  for unit in brain-runner-agents.service brain-runner-evaluators.service brain-runner-sre-host.service \
              brain-watchdog.timer brain-watchdog.service brain-standing-tests.timer brain-standing-tests.service \
              brain-replica-ship.timer brain-replica-ship.service; do
    as_root systemctl disable --now "$unit" >/dev/null 2>&1 || true
    as_root rm -f "/etc/systemd/system/$unit"
  done
  # The launcher and the runner hold files under run/, which is moved below; they are installed again in step 8.
  as_root systemctl stop brain-runner.service brain-launcher.service >/dev/null 2>&1 || true
  as_root rm -rf /etc/systemd/system/brain-launcher.service.d
  as_root rm -f /etc/sudoers.d/brain-watchdog
  as_root systemctl daemon-reload
  docker rm -f brain-egress-proxy >/dev/null 2>&1 || true

  # The earlier Governor is stopped, not removed: its container still names where its data is.
  OLD=""
  if [ -f "$REMOTE_DIR/docker-compose.yml" ]; then OLD="$(cd "$REMOTE_DIR" && docker compose ps -aq governor 2>/dev/null | head -n 1 || true)"; fi
  if [ -n "$OLD" ]; then docker stop "$OLD" >/dev/null; fi

  # ARCHIVE. A data directory is moved. Data the earlier stack kept in a Docker volume is copied out through a container
  # that mounts it (the earlier Governor's, or one made for the copy and never started); the volume itself is left exactly
  # as it is: no deploy ever runs `docker volume rm` or `docker compose down -v`.
  VOLUME="$(docker volume ls -q | grep -E '(^|_)brain-data$' | head -n 1 || true)"
  if [ -d "$REMOTE_DIR/data" ]; then
    mv "$REMOTE_DIR/data" "$ARCHIVE/data-$TS"
    echo "    moved $REMOTE_DIR/data to $ARCHIVE/data-$TS"
  elif [ -n "$OLD" ]; then
    docker cp "$OLD:/data" "$ARCHIVE/data-$TS"
    echo "    copied the earlier Governor's /data to $ARCHIVE/data-$TS"
  elif [ -n "$VOLUME" ] && [ -n "$(docker images -q | head -n 1)" ]; then
    HOLDER="$(docker create -v "$VOLUME:/data:ro" "$(docker images -q | head -n 1)" true)"
    docker cp "$HOLDER:/data" "$ARCHIVE/data-$TS"
    docker rm "$HOLDER" >/dev/null
    echo "    copied the Docker volume $VOLUME to $ARCHIVE/data-$TS"
  else
    echo "    there is no earlier data directory on this host"
  fi
  if [ -n "$VOLUME" ]; then echo "    the Docker volume $VOLUME of the earlier stack is left as it is"; fi
  for kept in run .env docker-compose.yml host-commands.json runner-agents.env runner-evaluators.env runner-sre-host.env replica.env replica; do
    if [ -e "$REMOTE_DIR/$kept" ]; then
      mkdir -p "$ARCHIVE/config-$TS"
      as_root mv "$REMOTE_DIR/$kept" "$ARCHIVE/config-$TS/$kept"
      as_root chown -R "$DEPLOY_USER" "$ARCHIVE/config-$TS"
    fi
  done

  # This version starts on an empty data directory.
  mkdir -p "$REMOTE_DIR/data"
  chmod 700 "$REMOTE_DIR/data"
  echo "$TS" > "$MARK"
  echo "    archive:"; ls -la "$ARCHIVE" | sed 's/^/      /'
fi
mkdir -p "$REMOTE_DIR/src" "$REMOTE_DIR/data" "$REMOTE_DIR/run/governor" "$REMOTE_DIR/run/runner/attempts" "$REMOTE_DIR/run/egress-grants"
chmod 700 "$REMOTE_DIR/data" "$REMOTE_DIR/run" "$REMOTE_DIR/run/governor" "$REMOTE_DIR/run/runner" "$REMOTE_DIR/run/egress-grants"
SCRIPT

# ---- 2. the source ----
locally "Sync the source to $TARGET:$REMOTE_DIR/src (nothing else is ever synced)" \
  rsync -az --delete --info=stats1 -e "ssh -p $PORT -o ConnectTimeout=15" \
  --exclude .git/ --exclude node_modules/ --exclude dist/ --exclude test-results/ --exclude playwright-report/ \
  --exclude .cache/ --exclude .claude/ --exclude .pi-agent/ --exclude .tower/ --exclude .vitest/ --exclude .zcode/ \
  --exclude '*.log' --exclude '*.pdf' \
  ./ "$TARGET:$REMOTE_DIR/src/"

# ---- 3. configuration ----
on_host "Install docker-compose.yml, .env and the host commands of the sre pack" <<'SCRIPT'
cd "$REMOTE_DIR"
install -m 0644 src/deploy/demo/docker-compose.yml docker-compose.yml
# host.status, host.logs, host.disk, host.restart and host.redeploy: the launcher runs exactly these command lines, as the
# deploy user. They use Docker, so that user must be in the docker group.
install -m 0644 src/deploy/demo/host-commands.json host-commands.json
if ! id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx docker; then as_root usermod -aG docker "$DEPLOY_USER"; fi
BRIDGE_IP="$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -n 1)"
[ -n "$BRIDGE_IP" ] || { echo "Docker's bridge network has no IPv4 gateway address" >&2; exit 1; }
umask 077
printf 'BRAIN_BASE_URL=https://%s\nBRAIN_UID=%s\nBRAIN_GID=%s\nBRAIN_BRIDGE_IP=%s\n' "$DOMAIN" "$(id -u)" "$(id -g)" "$BRIDGE_IP" > .env
SCRIPT

# ---- 4. images ----
on_host "Build the Governor image and the sandbox images (cached layers make a repeat deploy fast)" <<'SCRIPT'
cd "$REMOTE_DIR"
docker compose build governor
bash src/scripts/build-sandbox-images.sh >/dev/null
SCRIPT

# ---- 5. the Governor ----
on_host "Start the Governor and wait for /health/ready" <<'SCRIPT'
cd "$REMOTE_DIR"
docker compose up -d governor
for try in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:3100/health/ready; then echo "    the Governor is ready"; exit 0; fi
  sleep 2
done
echo "!! the Governor is not ready after two minutes. The end of its log:" >&2
docker compose logs --no-color --tail=40 governor >&2 || true
exit 1
SCRIPT

# ---- 6. the egress proxy ----
on_host "Start the egress proxy" <<'SCRIPT'
# Sandboxes are on a network with no way out but this proxy. It may reach the Governor's model gateway on Docker's bridge
# address (host.docker.internal:3100) because that is granted here; every other private address is refused.
docker network inspect brain-internal >/dev/null 2>&1 || docker network create --internal brain-internal >/dev/null
docker rm -f brain-egress-proxy >/dev/null 2>&1 || true
docker run -d --restart unless-stopped --name brain-egress-proxy --user "$(id -u):$(id -g)" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 256m --pids-limit 128 --add-host host.docker.internal:host-gateway \
  -e BRAIN_EGRESS_ALLOW_INTERNAL=host.docker.internal:3100 -v "$REMOTE_DIR/run/egress-grants:/grants:ro" brain-egress-proxy >/dev/null
docker network connect --alias brain-egress-proxy brain-internal brain-egress-proxy
SCRIPT

# ---- 7. Node and the dependencies of the launcher and the runner ----
on_host "Node 24, pnpm and the dependencies of the launcher and the runner on the host" <<'SCRIPT'
# A private folder: a predictable name in /tmp, written as root, could be a link someone else planted.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_24.x -o "$WORK/node-setup.sh"
  as_root bash "$WORK/node-setup.sh" >/dev/null
  as_root apt-get install -y nodejs >/dev/null
fi
command -v pnpm >/dev/null || as_root npm install -g pnpm@12.11.2 >/dev/null
cd "$REMOTE_DIR/src"
if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then pnpm install --frozen-lockfile > "$WORK/install.log" 2>&1 || { tail -n 30 "$WORK/install.log" >&2; exit 1; }; fi
SCRIPT

# ---- 8. the launcher and the runner ----
on_host "Install and start brain-launcher and brain-runner (one runner, engines $ENGINES)" <<'SCRIPT'
NODE="$(command -v node)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/brain-launcher.service" <<UNIT
[Unit]
Description=Brain launcher (starts sandboxes and runs the operator's host commands)
After=docker.service network-online.target
Wants=docker.service
[Service]
User=$DEPLOY_USER
WorkingDirectory=$REMOTE_DIR/src
Environment=BRAIN_LAUNCHER_SOCKET=$REMOTE_DIR/run/launcher.sock
Environment=BRAIN_LAUNCHER_ATTEMPTS_ROOT=$REMOTE_DIR/run/runner/attempts
Environment=BRAIN_LAUNCHER_EGRESS_GRANTS_DIR=$REMOTE_DIR/run/egress-grants
Environment=BRAIN_LAUNCHER_HOST_COMMANDS=$REMOTE_DIR/host-commands.json
ExecStart=$NODE --import tsx apps/launcher/src/main.ts
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
cat > "$WORK/brain-runner.service" <<UNIT
[Unit]
Description=Brain runner
After=brain-launcher.service
Wants=brain-launcher.service
[Service]
User=$DEPLOY_USER
WorkingDirectory=$REMOTE_DIR/src
EnvironmentFile=$REMOTE_DIR/runner.env
ExecStart=$NODE --import tsx apps/runner/src/main.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
as_root install -m 0644 "$WORK/brain-launcher.service" "$WORK/brain-runner.service" /etc/systemd/system/
as_root systemctl daemon-reload
as_root systemctl stop brain-runner.service >/dev/null 2>&1 || true

ENV_FILE="$REMOTE_DIR/runner.env"
TOKEN_FILE="$REMOTE_DIR/run/governor/runner.token"
umask 077
cat > "$ENV_FILE" <<ENV
BRAIN_GOVERNOR_URL=http://127.0.0.1:3100
BRAIN_LAUNCHER_SOCKET=$REMOTE_DIR/run/launcher.sock
BRAIN_RUNNER_STATE_DIR=$REMOTE_DIR/run/runner
BRAIN_RUNNER_NAME=demo
BRAIN_RUNNER_ENGINES=$ENGINES
BRAIN_RUNNER_SLOTS=$SLOTS
BRAIN_RUNNER_CAPABILITIES=bash,python3,curl,git
BRAIN_RUNNER_SANDBOX_CPU_MILLICORES=$SANDBOX_CPU
BRAIN_RUNNER_SANDBOX_MEMORY_MB=$SANDBOX_MEMORY
ENV
# The Governor leaves a one-use token while it has no runner (BRAIN_LOCAL_RUNNER_TOKEN_FILE). It lasts fifteen minutes, so one
# that has aged is made again by restarting the Governor. A credential from an earlier data directory would not be known to it.
if [ -s "$TOKEN_FILE" ]; then
  if [ -n "$(find "$TOKEN_FILE" -mmin +10)" ]; then
    (cd "$REMOTE_DIR" && docker compose restart governor >/dev/null)
    for try in $(seq 1 60); do curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:3100/health/ready && break; sleep 2; done
  fi
  rm -f "$REMOTE_DIR/run/runner/credential"
  printf 'BRAIN_RUNNER_ENROLL_TOKEN=%s\n' "$(cat "$TOKEN_FILE")" >> "$ENV_FILE"
  ENROLLING=1
else
  ENROLLING=0
fi
as_root systemctl enable brain-launcher.service brain-runner.service >/dev/null 2>&1
as_root systemctl restart brain-launcher.service
for try in $(seq 1 30); do [ -S "$REMOTE_DIR/run/launcher.sock" ] && break; sleep 1; done
[ -S "$REMOTE_DIR/run/launcher.sock" ] || { echo "!! the launcher did not open its socket: journalctl -u brain-launcher -n 40" >&2; exit 1; }
as_root systemctl start brain-runner.service
if [ "$ENROLLING" = 1 ]; then
  for try in $(seq 1 30); do [ -s "$REMOTE_DIR/run/runner/credential" ] && break; sleep 1; done
  # The token is used: it leaves the env file and the disk.
  sed -i '/^BRAIN_RUNNER_ENROLL_TOKEN=/d' "$ENV_FILE"
  rm -f "$TOKEN_FILE"
  [ -s "$REMOTE_DIR/run/runner/credential" ] || { echo "!! the runner did not enrol: journalctl -u brain-runner -n 40" >&2; exit 1; }
  echo "    the runner enrolled"
fi
SCRIPT

# ---- 9. backups ----
on_host "The nightly backup and the monthly restore rehearsal (only with $REMOTE_DIR/backup.env)" <<'SCRIPT'
if [ -r "$REMOTE_DIR/backup.env" ]; then
  chmod +x "$REMOTE_DIR/src/deploy/demo/backup/backup-live.sh" "$REMOTE_DIR/src/deploy/demo/backup/restore-test.sh"
  as_root install -m 0644 "$REMOTE_DIR/src/deploy/demo/backup/brain-backup.service" "$REMOTE_DIR/src/deploy/demo/backup/brain-backup.timer" \
    "$REMOTE_DIR/src/deploy/demo/backup/brain-restore-test.service" "$REMOTE_DIR/src/deploy/demo/backup/brain-restore-test.timer" /etc/systemd/system/
  as_root systemctl daemon-reload
  as_root systemctl enable --now brain-backup.timer brain-restore-test.timer >/dev/null 2>&1
  echo "    the backup timers are on"
else
  echo "    no $REMOTE_DIR/backup.env on the host: nightly backups are NOT scheduled (it names BRAIN_BACKUP_HOST)"
fi
SCRIPT

# ---- 10. checks ----
on_host "Checks" <<'SCRIPT'
for unit in brain-launcher brain-runner; do echo "    $unit: $(systemctl is-active "$unit" || true)"; done
echo "    governor: $(curl -fsS --max-time 5 http://127.0.0.1:3100/health/ready || echo 'NOT READY')"
# What an engine in a sandbox needs: the proxy's container reaching the Governor on Docker's bridge address.
if docker exec brain-egress-proxy node -e "fetch('http://host.docker.internal:3100/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
  echo "    sandboxes reach the model gateway"
else
  echo "!! the egress proxy cannot reach the Governor at host.docker.internal:3100: engines in sandboxes will get no model. Check the host's firewall for the Docker bridge." >&2
fi
if [ -s "$REMOTE_DIR/data/setup.token" ]; then
  echo "    This is a fresh install. Create the first account here:"
  echo "      https://$DOMAIN/#token=$(cat "$REMOTE_DIR/data/setup.token")"
fi
SCRIPT

echo "==> Done. https://$DOMAIN"
