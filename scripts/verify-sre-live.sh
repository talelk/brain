#!/usr/bin/env bash
# Start a small read-only mission on the live demo and report the tokens each task used (live check of the SRE agent).
# Credentials: ~/.config/brain-dev/credentials.env (host/port). The administrator sign-in is read ON THE SERVER from
# /srv/demos/brain/.env by the remote program; no password is passed from this machine.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . "${BRAIN_DEV_CREDENTIALS:-$HOME/.config/brain-dev/credentials.env}"; set +a
HOST="${BRAIN_DEPLOY_HOST:-ns390729}"; PORT="${BRAIN_DEPLOY_PORT:-42242}"
eval "$(ssh-agent -s)" >/dev/null; trap 'ssh-agent -k >/dev/null' EXIT
ssh-add "${BRAIN_SSH_KEY:-$HOME/dev/keys/id_rsa}" 2>/dev/null
python3 - <<'PY' | ssh -p "$PORT" "talel@$HOST" 'python3 -c "import sys,os;exec(sys.stdin.read())"'
import base64, json, pathlib, re, shlex
files = {}
script = open("scripts/demo/verify-sre-live.py").read()
# the remote program: set the sign-in, then run the provisioner with the documents as its stdin
print("import os, subprocess, sys")
print("os.environ['BRAIN_PROVISION_REVISE']=%r" % __import__("os").environ.get("BRAIN_PROVISION_REVISE", ""))
print("env = dict(l.strip().split('=', 1) for l in open('/srv/demos/brain/.env') if '=' in l and not l.startswith('#'))")
print("os.environ['BRAIN_ADMIN_EMAIL']=env.get('BRAIN_ADMIN_EMAIL', 'admin@brain.local'); os.environ['BRAIN_ADMIN_PASSWORD']=env['BRAIN_ADMIN_PASSWORD']")
print("subprocess.run(['python3','-c',%r], input=%r, text=True, check=True)" % (script, json.dumps(files)))
PY
