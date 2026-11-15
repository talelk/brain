#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, subprocess, sys
script = sys.argv[1]
def run(payload):
 r = subprocess.run(["bash", script], input=json.dumps(payload), capture_output=True, text=True)
 return r.returncode, json.loads(r.stdout)
code, out = run({"broker": {"recorded": True, "planVersionId": "plan-1", "state": "proposed", "outcome": "waits for a person"}})
assert code == 0 and out["recorded"] is True and out["planVersionId"] == "plan-1" and out["state"] == "proposed", out
code, out = run({})
assert code == 2 and "error" in out, out
print("mission.propose-plan: ok")
CHECKS
