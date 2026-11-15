#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, subprocess, sys
script = sys.argv[1]
def run(payload):
 r = subprocess.run(["bash", script], input=json.dumps(payload), capture_output=True, text=True)
 return r.returncode, json.loads(r.stdout)
good = json.loads('{"url": "https://git.example/r/pull/7", "number": 7, "branch": "brain/fix-1", "commit": "abc123"}')
code, out = run({"broker": {**good, "token": "must-not-pass", "password": "must-not-pass"}})
assert code == 0 and out == good, out
code, out = run({})
assert code == 2 and "error" in out, out
print("git.open-pr: ok")
CHECKS
