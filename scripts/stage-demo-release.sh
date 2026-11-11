#!/usr/bin/env bash
# Compile, stage, inspect and activate examples/v1/starter-release on the live demo,
# then restart the launcher + runners so they fetch newly pinned tools.
# Run AFTER scripts/deploy-demo.sh (the container must hold the checkout you want to stage).
# Credentials: ~/.config/brain-dev/credentials.env (BRAIN_DEPLOY_SUDO_PASSWORD, BRAIN_DEPLOY_HOST, BRAIN_DEPLOY_PORT).
# The demo admin sign-in is read from scripts/demo/provision-cv-insights.py and sent over stdin only.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . "${BRAIN_DEV_CREDENTIALS:-$HOME/.config/brain-dev/credentials.env}"; set +a
HOST="${BRAIN_DEPLOY_HOST:-ns390729}"; PORT="${BRAIN_DEPLOY_PORT:-42242}"
ORIGIN="${BRAIN_PUBLIC_ORIGIN:-https://brain.mykeyrus.tn}"
eval "$(ssh-agent -s)" >/dev/null; trap 'ssh-agent -k >/dev/null' EXIT
ssh-add "${BRAIN_SSH_KEY:-$HOME/dev/keys/id_rsa}" 2>/dev/null
{
  python3 - <<'PY'
import re, shlex
t = open("scripts/demo/provision-cv-insights.py").read()
m = re.search(r'ADMIN = \{"email": "([^"]+)", "password": "([^"]+)"\}', t)
print("export BE=%s BP=%s" % (shlex.quote(m.group(1)), shlex.quote(m.group(2))))
PY
  cat <<EOF2
cd /app
TOKEN=\$(node -e 'fetch("http://127.0.0.1:3100/api/auth/sign-in/email",{method:"POST",headers:{"content-type":"application/json",origin:"$ORIGIN"},body:JSON.stringify({email:process.env.BE,password:process.env.BP})}).then(r=>r.json()).then(j=>process.stdout.write(j.token||""))')
[ -n "\$TOKEN" ] || { echo "sign-in failed"; exit 1; }
export BRAIN_TOKEN="\$TOKEN" BRAIN_GOVERNOR_URL=http://127.0.0.1:3100
CLI="pnpm exec tsx apps/cli/src/main.ts"
D=\$(\$CLI config compile examples/v1/starter-release --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).digest))')
echo "staged \$D"
\$CLI config inspect "\$D" --json >/dev/null
\$CLI config activate "\$D" --json | tail -c 300
EOF2
} | ssh -p "$PORT" "talel@$HOST" 'docker exec -i brain-governor-1 sh -s'
ssh -p "$PORT" "talel@$HOST" "echo '$BRAIN_DEPLOY_SUDO_PASSWORD' | sudo -S systemctl restart brain-launcher brain-runner-agents brain-runner-evaluators >/dev/null 2>&1; sleep 5; systemctl is-active brain-launcher brain-runner-agents brain-runner-evaluators"
echo "==> release staged, activated; runners restarted. Wait ~1 minute before judging runs."
