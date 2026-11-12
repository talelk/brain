#!/usr/bin/env bash
# Create/refresh the "sre-demos" workspace on the live demo (documents, mission, plan).
# Credentials: ~/.config/brain-dev/credentials.env (host/port); the demo admin sign-in is read from
# scripts/demo/provision-cv-insights.py and sent over stdin only.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . "${BRAIN_DEV_CREDENTIALS:-$HOME/.config/brain-dev/credentials.env}"; set +a
HOST="${BRAIN_DEPLOY_HOST:-ns390729}"; PORT="${BRAIN_DEPLOY_PORT:-42242}"
eval "$(ssh-agent -s)" >/dev/null; trap 'ssh-agent -k >/dev/null' EXIT
ssh-add "${BRAIN_SSH_KEY:-$HOME/dev/keys/id_rsa}" 2>/dev/null
python3 - <<'PY' | ssh -p "$PORT" "talel@$HOST" 'python3 -c "import sys,os;exec(sys.stdin.read())"'
import base64, json, pathlib, re, shlex
t = open("scripts/demo/provision-cv-insights.py").read()
m = re.search(r'ADMIN = \{"email": "([^"]+)", "password": "([^"]+)"\}', t)
files = {p.name: p.read_text() for p in pathlib.Path("scripts/demo/sre-demos").glob("*.md")}
script = open("scripts/demo/provision-sre-demos.py").read()
# the remote program: set the sign-in, then run the provisioner with the documents as its stdin
print("import os, subprocess, sys")
print("os.environ['BRAIN_ADMIN_EMAIL']=%r; os.environ['BRAIN_ADMIN_PASSWORD']=%r" % (m.group(1), m.group(2)))
print("subprocess.run(['python3','-c',%r], input=%r, text=True, check=True)" % (script, json.dumps(files)))
PY
