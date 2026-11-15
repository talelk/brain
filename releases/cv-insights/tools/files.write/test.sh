#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, subprocess, sys
script = sys.argv[1]
def run(payload):
 r = subprocess.run(["bash", script], input=json.dumps(payload), capture_output=True, text=True)
 return r.returncode, json.loads(r.stdout)
broker = {"name": "report.md", "bytes": 12, "files": 1, "totalBytes": 12, "replaced": False}
code, out = run({"name": "report.md", "broker": broker})
assert code == 0 and out == broker, out
code, out = run({"name": "report.md", "broker": {**broker, "extra": "ignored"}})
assert code == 0 and "extra" not in out, out
code, out = run({"name": "report.md"})
assert code == 2 and "error" in out, out
print("files.write: ok")
CHECKS
