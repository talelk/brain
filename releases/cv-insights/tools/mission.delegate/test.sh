#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, subprocess, sys
script = sys.argv[1]
def run(payload):
 r = subprocess.run(["bash", script], input=json.dumps(payload), capture_output=True, text=True)
 return r.returncode, json.loads(r.stdout)
code, out = run({"broker": {"recorded": True, "id": "delegation-1"}})
assert code == 0 and out["recorded"] is True and out["id"] == "delegation-1" and "child session" in out["note"], out
code, out = run({})
assert code == 2 and "error" in out, out
print("mission.delegate: ok")
CHECKS
