#!/usr/bin/env bash
# Deploy the latest Keyrus Brain working tree to the demo server WITHOUT resetting.
#
# Brings up / refreshes the whole stack:
#   * governor container (Web UI + API)  — brain.mykeyrus.tn
#   * TencentDB Agent Memory stack       — core/hub/proxy on 127.0.0.1
#   * launcher + two runners             — Pi (agents) + Claude (evaluators)
#
# What it does every run:
#   1. rsync the current checkout to /srv/demos/brain/src (data is never synced)
#   2. (re)install the compose file from deploy/demo/docker-compose.yml
#   3. create /srv/demos/brain/.env on first deploy only (never touched again)
#   4. build + recreate the governor container; run first-launch init only if the
#      data volume is empty (idempotent — existing orgs/workspaces are preserved)
#   5. ensure the TencentDB memory stack is running and bound to 127.0.0.1
#   6. ensure sandbox images, host Node toolchain and runner units exist
#   7. restart the launcher + runners so they run the freshly synced code
#
# What it never does: reset, `down -v`, remove the brain-data volume, or touch
# accounts/workspaces/runs. Existing data always survives.
#
# Usage: BRAIN_DEPLOY_SUDO_PASSWORD=... scripts/deploy-demo.sh   (from the repo root)
#        BRAIN_DEPLOY_HOST=... BRAIN_DEPLOY_PORT=... BRAIN_DEPLOY_SUDO_PASSWORD=... scripts/deploy-demo.sh
#        (a schema-changing release needs the live databases brought to the current
#        schema first; scripts/repair-live-schema.ts refuses to alter existing tables)
set -euo pipefail

# Dev machines keep the deploy host, port and sudo password in a private file; load it without echoing anything.
if [ -z "${BRAIN_DEPLOY_SUDO_PASSWORD:-}" ] && [ -r "$HOME/.config/brain-dev/credentials.env" ]; then
  set -a; . "$HOME/.config/brain-dev/credentials.env"; set +a
fi

HOST="${BRAIN_DEPLOY_HOST:-demos.mykeyrus.tn}"
PORT="${BRAIN_DEPLOY_PORT:-42242}"
USER_SSH="${BRAIN_DEPLOY_USER:-talel}"
REMOTE_DIR="${BRAIN_DEPLOY_DIR:-/srv/demos/brain}"
SSH="ssh -p $PORT -o ConnectTimeout=15 $USER_SSH@$HOST"
DOMAIN="${BRAIN_DEMO_DOMAIN:-brain.mykeyrus.tn}"
TDAI_REVISION="ecc01a545da0b2ac6cae2f0f0af0d39d41469793"
MODEL_URL="${BRAIN_LOCAL_MODEL_URL:-http://tntungx10:8000/v1}"
MODEL_ID="${BRAIN_LOCAL_MODEL_ID:-qwen3.8-flash-next-a5b}"

cd "$(dirname "$0")/.."
command -v rsync >/dev/null || { echo "rsync is required" >&2; exit 1; }
# The deploy user's sudo password comes from the environment and is never stored
# in the repository. (A sudoers NOPASSWD rule for the systemctl/apt commands used
# below would avoid passing a password at all.)
: "${BRAIN_DEPLOY_SUDO_PASSWORD:?set BRAIN_DEPLOY_SUDO_PASSWORD to the sudo password of the deploy user}"
SUDO="printf '%s\n' $(printf '%q' "$BRAIN_DEPLOY_SUDO_PASSWORD") | sudo -S -p ''"   # only for system-level actions

# ---- pre-deploy check: prove the live databases can be upgraded BEFORE anything on the server changes ----
# Copies the live databases (read-only) to a private local directory and runs scripts/repair-live-schema.ts of this
# checkout against the copy. If it fails the deploy aborts here: the old container keeps serving, nothing was synced.
# Skipped on a first deploy (no running governor yet) and with BRAIN_DEPLOY_SKIP_PRECHECK=1.
if [ "${BRAIN_DEPLOY_SKIP_PRECHECK:-0}" != 1 ]; then
  GOV_ID="$($SSH "cd $REMOTE_DIR 2>/dev/null && docker compose ps -q governor 2>/dev/null" || true)"
  if [ -n "$GOV_ID" ]; then
    echo "==> Pre-deploy check: repairing a copy of the live databases with this checkout's schema"
    PRECHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/brain-precheck-XXXXXX")"
    trap 'rm -rf "$PRECHECK_DIR"' EXIT
    chmod 700 "$PRECHECK_DIR"
    # A consistent snapshot (VACUUM INTO inside the container), then a copy of the static snapshot: copying files
    # that are being written is what made a raw tar of the live databases fail at random.
    if ! $SSH "docker exec -i $GOV_ID node --input-type=module -" < scripts/snapshot-live-dbs.mjs >/dev/null \
      || ! $SSH "docker exec $GOV_ID tar cf - -C /tmp/precheck-snap ." | tar xf - -C "$PRECHECK_DIR" \
      || [ ! -s "$PRECHECK_DIR/control.db" ]; then
      echo "!! Could not snapshot the live databases; aborting before any change (old container untouched)" >&2; exit 1
    fi
    $SSH "docker exec $GOV_ID rm -rf /tmp/precheck-snap" >/dev/null 2>&1 || true
    if ! BRAIN_DATA_DIR="$PRECHECK_DIR" pnpm exec tsx scripts/repair-live-schema.ts; then
      echo "!! Schema repair FAILED against a copy of the live databases; aborting before any change (old container still running)." >&2
      echo "   A new column on an existing table needs DEFAULT (see docs/wiki/ops-live-server.md)." >&2
      exit 1
    fi
    echo "==> Pre-deploy check passed"
  else
    echo "==> No running governor found; skipping the pre-deploy schema check"
  fi
fi

echo "==> Syncing source to $USER_SSH@$HOST:$REMOTE_DIR/src (data is never synced)"
$SSH "mkdir -p $REMOTE_DIR/src"
rsync -az --delete --info=stats1 \
  -e "ssh -p $PORT" \
  --exclude .git/ --exclude node_modules/ --exclude test-results/ \
  --exclude playwright-report/ --exclude /artifacts/ --exclude screenshots/ \
  --exclude .pi-agent/ --exclude .vitest/ --exclude .zcode/ --exclude '*.log' \
  ./ "$USER_SSH@$HOST:$REMOTE_DIR/src/"

echo "==> Installing compose file"
scp -P "$PORT" deploy/demo/docker-compose.yml "$USER_SSH@$HOST:$REMOTE_DIR/docker-compose.yml.new"
$SSH "test -f $REMOTE_DIR/docker-compose.yml && cp -a $REMOTE_DIR/docker-compose.yml $REMOTE_DIR/docker-compose.yml.bak.\$(date +%s) || true
     mv $REMOTE_DIR/docker-compose.yml.new $REMOTE_DIR/docker-compose.yml"

# .env is created once on first deploy; later deploys must not change credentials.
FIRST_RUN=0
if ! $SSH "test -f $REMOTE_DIR/.env"; then
  FIRST_RUN=1
  echo "==> First deploy: generating credentials"
  ADMIN_EMAIL="${BRAIN_ADMIN_EMAIL:-admin@brain.local}"
  ADMIN_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  $SSH "umask 077 && cat > $REMOTE_DIR/.env" <<EOF
BRAIN_BASE_URL=https://$DOMAIN
BRAIN_ADMIN_EMAIL=$ADMIN_EMAIL
BRAIN_ADMIN_PASSWORD=$ADMIN_PASS
EOF
  echo "    Admin: $ADMIN_EMAIL / $ADMIN_PASS"
  echo "    Saved to $REMOTE_DIR/.env — record it now."
else
  echo "==> Keeping existing .env (credentials unchanged)"
fi

# ---- TencentDB memory stack (idempotent; binds 127.0.0.1 only) ----
echo "==> Ensuring TencentDB memory stack"
$SSH "mkdir -p $REMOTE_DIR/tencentdb $REMOTE_DIR/run"
$SSH "cd $REMOTE_DIR/tencentdb && if [ ! -d checkout/.git ]; then
        git clone --filter=blob:none --no-checkout https://github.com/TencentCloud/TencentDB-Agent-Memory.git checkout >/dev/null 2>&1;
      fi
      cd checkout && git sparse-checkout set deploy/global-images MemoryCore/pi-plugin >/dev/null 2>&1
      git checkout --detach $TDAI_REVISION >/dev/null 2>&1
      cd deploy/global-images
      [ -f .env ] || cp .env.example .env
      chmod 600 .env
      sed -i -e 's|^MEMORY_CORE_PORT=.*|MEMORY_CORE_PORT=8420|' -e 's|^PANEL_PORT=.*|PANEL_PORT=8125|' \
             -e 's|^KNOWLEDGE_PORT=.*|KNOWLEDGE_PORT=8424|' -e 's|^PROXY_PORT=.*|PROXY_PORT=8096|' \
             -e 's|^MEMORY_LLM_BASE_URL=.*|MEMORY_LLM_BASE_URL=$MODEL_URL|' -e 's|^MEMORY_LLM_API_KEY=.*|MEMORY_LLM_API_KEY=local-no-key|' \
             -e 's|^MEMORY_LLM_MODEL=.*|MEMORY_LLM_MODEL=$MODEL_ID|' -e 's|^MEMORY_LLM_PROTOCOL=.*|MEMORY_LLM_PROTOCOL=openai|' \
             -e 's|^PROXY_UPSTREAM_URL=.*|PROXY_UPSTREAM_URL=$MODEL_URL|' -e 's|^PROXY_UPSTREAM_API_KEY=.*|PROXY_UPSTREAM_API_KEY=local-no-key|' \
             -e 's|^PROXY_UPSTREAM_MODEL=.*|PROXY_UPSTREAM_MODEL=$MODEL_ID|' .env
      grep -q '^PROXY_FULL_STACK=' .env || echo 'PROXY_FULL_STACK=1' >> .env
      for f in start-memory-core.sh start-memory-hub.sh start-proxy.sh; do
        sed -i -E 's|-p \"(\\\$\{[A-Z_]+PORT\}):([0-9]+)\"|-p \"127.0.0.1:\1:\2\"|g' \$f
        sed -i 's|run -d --name \"\\\$CONTAINER\"|run -d --restart unless-stopped --name \"\\\$CONTAINER\"|' \$f
      done"
if ! $SSH "docker ps -q -f name=tdai-memory-core" | grep -q .; then
  echo "    starting memory stack"
  $SSH "cd $REMOTE_DIR/tencentdb/checkout/deploy/global-images && bash start-all.sh </dev/null >/tmp/tdai-start.log 2>&1"
fi

# ---- sandbox images (for launcher-enforced isolation) ----
echo "==> Ensuring sandbox images"
if ! $SSH "docker images -q brain-sandbox-agent" | grep -q .; then
  $SSH "cd $REMOTE_DIR/src && bash scripts/build-sandbox-images.sh >/dev/null 2>&1"
fi

echo "==> Building the governor image (cached layers make repeat deploys fast)"
$SSH "cd $REMOTE_DIR && docker compose build governor"

echo "==> Rolling the container (stop -> repair-if-needed -> initialize-if-empty -> up)"
# initialize-local.ts needs exclusive ownership of the data directory and is
# idempotent: with existing organizations it preserves everything and exits.
# repair-live-schema.ts is likewise idempotent: on a current database it only
# reports digests; on a database predating a schema-file change it creates the
# declared tables the file added, verifies columns, and realigns digests.
# Rows are never touched either way.
$SSH "cd $REMOTE_DIR && docker compose stop governor \
  && docker compose run --rm --no-deps governor node --import tsx scripts/repair-live-schema.ts \
  && docker compose run --rm --no-deps governor node --import tsx scripts/initialize-local.ts \
  && docker compose up -d governor" || {
  echo "!! Rolling the governor failed; restarting the previous container so the site keeps serving" >&2
  $SSH "cd $REMOTE_DIR && docker compose start governor" >&2 || true
  exit 1
}

echo "==> Waiting for /health/ready"
for i in $(seq 1 30); do
  if $SSH "curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:3100/health/ready"; then
    echo "==> Governor is healthy"; break
  fi
  if [ "$i" = 30 ]; then
    echo "!! Governor not ready after 30 tries. First error lines from its log:" >&2
    $SSH "cd $REMOTE_DIR && docker compose logs --no-color --tail=200 governor 2>&1 | grep -iE -m 15 'error|refus|diverge|fatal|cannot|failed' || docker compose logs --no-color --tail=15 governor 2>&1" >&2 || true
    echo "   Full log: $SSH 'cd $REMOTE_DIR && docker compose logs --tail=100 governor'" >&2
    exit 1
  fi
  sleep 2
done

# ---- host Node toolchain for launcher/runners (first deploy only) ----
if ! $SSH "node -e 'process.exit(Number(process.versions.node.split(\".\")[0])>=24?0:1)' 2>/dev/null"; then
  echo "==> Installing Node 24 + pnpm on the host (first deploy)"
  $SSH "curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nsetup.sh && $SUDO bash /tmp/nsetup.sh >/dev/null 2>&1 && $SUDO apt-get install -y nodejs >/dev/null 2>&1 && $SUDO npm install -g pnpm@12.11.2 >/dev/null 2>&1"
fi
# refresh host node_modules when the lockfile is newer than what is installed
$SSH "cd $REMOTE_DIR/src && if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules/.modules-state ] 2>/dev/null; then pnpm install --frozen-lockfile >/tmp/brain-host-install.log 2>&1 && pnpm approve-builds better-sqlite3 esbuild >>/tmp/brain-host-install.log 2>&1 && pnpm rebuild better-sqlite3 >>/tmp/brain-host-install.log 2>&1; fi"

# ---- memory wiring for the governor container (idempotent) ----
if ! $SSH "grep -q BRAIN_TENCENTDB_URL $REMOTE_DIR/.env"; then
  $SSH "KEY=\$(cat $REMOTE_DIR/tencentdb/checkout/deploy/global-images/.admin-key);
        umask 077; { echo BRAIN_TENCENTDB_URL=http://tdai-memory-core:8420; echo BRAIN_MEMORY_UI_URL=https://memory.$(echo "$DOMAIN" | cut -d. -f2-); echo BRAIN_TENCENTDB_API_KEY=\$KEY; } >> $REMOTE_DIR/.env"
  $SSH "cd $REMOTE_DIR && docker compose up -d governor"
fi

# ---- launcher + runner systemd units ----
if ! $SSH "systemctl list-unit-files --type=service" 2>/dev/null | grep -q "brain-runner-agents.service"; then
  echo "==> First deploy: installing launcher + runner units and enrolling runners"
  # create the evaluator memory binding (user/team/agent + claude user key)
  $SSH "cat > /tmp/tdai-bind.mjs" <<'BIND'
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
const coreUrl = "http://127.0.0.1:8420", runDir = "/run/brain";
const adminKey = readFileSync("/deploy/.admin-key", "utf8").trim();
function pw(f, v) { mkdirSync(dirname(f), { recursive: true, mode: 0o700 }); const t = f + "." + process.pid + ".tmp"; writeFileSync(t, v, { mode: 0o600 }); renameSync(t, f); chmodSync(f, 0o600); }
async function api(p, b, k = adminKey) { const r = await fetch(coreUrl + "/v3/meta" + p, { method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": "default", "x-tdai-user-key": k }, body: JSON.stringify(b), signal: AbortSignal.timeout(10000) }); const e = await r.json(); if (!r.ok || e.code !== 0 || !e.data) throw new Error(p + ": " + (e.message || r.status)); return e.data; }
const users = await api("/user/list", { username: "brain_local_evaluator", limit: 100 });
const userId = users.items[0]?.user_id ?? (await api("/user/create", { username: "brain_local_evaluator", user_id: "brain_local_evaluator" })).user_id;
const created = await api("/user-key/create", { user_id: userId, name: "brain-demo-claude" });
pw(join(runDir, "tencentdb-claude-user-key"), created.key_value + "\n");
const teams = await api("/team/list", { user_id: userId, limit: 100 });
const teamId = teams.items.find((t) => t.name === "Brain Local")?.team_id ?? (await api("/team/create", { name: "Brain Local", owner_user_id: userId, description: "Brain demo runner memory" }, created.key_value)).team_id;
const agents = await api("/agent/list", { team_id: teamId, limit: 100 });
const agentId = agents.items.find((a) => a.name === "Brain Evaluator")?.agent_id ?? (await api("/agent/create", { team_id: teamId, owner_user_id: userId, name: "Brain Evaluator", description: "Independent Brain workflow evaluation", prompt: "Evaluate Brain outputs using only the pinned evaluator and immutable evidence.", visibility: "team" }, created.key_value)).agent_id;
pw(join(runDir, "tencentdb-binding.json"), JSON.stringify({ teamId, agentId, userId }) + "\n");
console.log("BINDING " + teamId + " " + agentId);
BIND
  $SSH "docker run --rm --network host -v $REMOTE_DIR/tencentdb/checkout/deploy/global-images:/deploy:ro -v $REMOTE_DIR/run:/run/brain -v /tmp/tdai-bind.mjs:/bind.mjs:ro node:24-slim node /bind.mjs"

  # unit files
  $SSH "cat > /tmp/brain-launcher.service" <<'EOF'
[Unit]
Description=Keyrus Brain launcher (sandbox supervisor)
After=docker.service network-online.target
Wants=docker.service
[Service]
User=talel
WorkingDirectory=/srv/demos/brain/src
Environment=BRAIN_LAUNCHER_SOCKET=/srv/demos/brain/run/launcher.sock
ExecStart=/usr/bin/pnpm exec tsx apps/launcher/src/main.ts
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
  for g in agents evaluators; do
    eng=pi; [ "$g" = evaluators ] && eng=claude
    $SSH "cat > /tmp/brain-runner-$g.service" <<EOF
[Unit]
Description=Keyrus Brain runner ($g group, $eng engine)
After=brain-launcher.service
Wants=brain-launcher.service
[Service]
User=talel
WorkingDirectory=/srv/demos/brain/src
EnvironmentFile=$REMOTE_DIR/runner-$g.env
ExecStart=/usr/bin/pnpm exec tsx apps/runner/src/main.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
  done
  $SSH "$SUDO cp /tmp/brain-*.service /etc/systemd/system/ && $SUDO systemctl daemon-reload"

  # enrollment tokens via the API
  ADMIN_PW=$(grep BRAIN_ADMIN_PASSWORD "$REMOTE_DIR/.env" 2>/dev/null | cut -d= -f2 || echo admin-password)
  ADMIN_EM=$(grep BRAIN_ADMIN_EMAIL "$REMOTE_DIR/.env" 2>/dev/null | cut -d= -f2 || echo admin@brain.local)
  TOKEN=$($SSH "curl -s -m 10 -X POST http://127.0.0.1:3100/api/auth/sign-in/email -H 'content-type: application/json' -d '{\"email\":\"$ADMIN_EM\",\"password\":\"$ADMIN_PW\"}'" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
  tok() { $SSH "curl -s -m 10 -X POST http://127.0.0.1:3100/v1/runner-tokens -H 'authorization: Bearer $TOKEN' -H 'content-type: application/json' -d '{\"groupId\":\"$1\"}'" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])"; }
  TOK_AG=$(tok agents); TOK_EV=$(tok evaluators)
  BIND_IDS=$($SSH "cat $REMOTE_DIR/run/tencentdb-binding.json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['teamId'],d['agentId'])")

  $SSH "umask 077; cat > $REMOTE_DIR/runner-agents.env" <<EOF
BRAIN_GOVERNOR_URL=http://127.0.0.1:3100
BRAIN_LAUNCHER_SOCKET=/srv/demos/brain/run/launcher.sock
BRAIN_RUNNER_STATE_DIR=/srv/demos/brain/run/runner-agents-1-state
BRAIN_RUNNER_ID=runner-agents-1
BRAIN_RUNNER_ENGINE=pi
BRAIN_RUNNER_CAPABILITIES=os:linux,arch:amd64,tool:bash,tool:python3,isolation:ephemeral-container
BRAIN_LOCAL_MODEL_URL=$MODEL_URL
BRAIN_LOCAL_MODEL_ID=$MODEL_ID
BRAIN_RUNNER_ENROLL_TOKEN=$TOK_AG
EOF
  $SSH "umask 077; cat > $REMOTE_DIR/runner-evaluators.env" <<EOF
BRAIN_GOVERNOR_URL=http://127.0.0.1:3100
BRAIN_LAUNCHER_SOCKET=/srv/demos/brain/run/launcher.sock
BRAIN_RUNNER_STATE_DIR=/srv/demos/brain/run/runner-evaluators-1-state
BRAIN_RUNNER_ID=runner-evaluators-1
BRAIN_RUNNER_ENGINE=claude
BRAIN_RUNNER_CAPABILITIES=os:linux,arch:amd64,tool:bash,tool:python3,isolation:ephemeral-container
BRAIN_LOCAL_MODEL_URL=$MODEL_URL
BRAIN_LOCAL_MODEL_ID=$MODEL_ID
BRAIN_CLAUDE_MODEL=$MODEL_ID
BRAIN_ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
BRAIN_ANTHROPIC_API_KEY_FILE=$REMOTE_DIR/run/tencentdb-claude-user-key
BRAIN_TENCENTDB_TEAM_ID=$(echo "$BIND_IDS" | cut -d' ' -f1)
BRAIN_TENCENTDB_AGENT_ID=$(echo "$BIND_IDS" | cut -d' ' -f2)
BRAIN_RUNNER_ENROLL_TOKEN=$TOK_EV
EOF
  $SSH "$SUDO systemctl enable --now brain-launcher brain-runner-agents brain-runner-evaluators >/dev/null 2>&1"
else
  echo "==> Restarting launcher + runners to pick up synced code"
  $SSH "$SUDO systemctl restart brain-launcher brain-runner-agents brain-runner-evaluators"
fi

scripts/refresh-released-schema.sh || true   # the schema just deployed becomes the "previously released" fixture
echo "    Commit tests/fixtures/released-schema so the next deploy is checked against what is live now."
echo "==> Done. https://$DOMAIN"
if [ "$FIRST_RUN" = 1 ]; then
  echo "    Sign in with the admin credentials printed above."
fi
