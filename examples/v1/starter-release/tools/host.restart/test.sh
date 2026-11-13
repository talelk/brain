#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, subprocess, sys
script = sys.argv[1]
def run(payload):
 r = subprocess.run(["bash", script], input=json.dumps(payload), capture_output=True, text=True)
 return r.returncode, json.loads(r.stdout)
ok = {"command": "docker.restart", "exitCode": 0, "stdout": "demo-app\nAPI_TOKEN=abc123\n", "stderr": "", "timedOut": False}
code, out = run({"container": "demo-app", "broker": ok})
assert code == 0 and "demo-app" in out["output"] and "abc123" not in out["output"] and out["exitCode"] == 0, out
code, out = run({"container": "demo-app"})
assert code == 2 and "error" in out, out
print("host.restart: ok")
CHECKS
