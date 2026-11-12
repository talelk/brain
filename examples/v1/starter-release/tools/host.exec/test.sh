#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, subprocess, sys
script = sys.argv[1]
def run(payload):
 r = subprocess.run(["bash", script], input=json.dumps(payload), capture_output=True, text=True)
 return r.returncode, json.loads(r.stdout)
ok = {"command": "host.df", "exitCode": 0, "stdout": "Filesystem Size\n/dev/sda3 1.8T\nAPI_TOKEN=abc123\nAuthorization: Bearer abcdefghijklmnop12345\n", "stderr": "", "timedOut": False}
code, out = run({"command": "host.df", "broker": ok})
assert code == 0 and "1.8T" in out["output"] and "abc123" not in out["output"] and "abcdefghijklmnop12345" not in out["output"] and out["exitCode"] == 0, out
code, out = run({"command": "host.df", "broker": {**ok, "stdout": "x" * 20000}})
assert code == 0 and len(out["output"]) == 12000 and out["truncated"] is True, out
code, out = run({"command": "host.df"})
assert code == 2 and "error" in out, out
print("host.exec: ok")
CHECKS
