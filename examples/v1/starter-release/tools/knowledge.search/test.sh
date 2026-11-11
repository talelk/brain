#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, subprocess, sys
script = sys.argv[1]
hit = lambda i, n=100: {"sourceId": "src-%d" % i, "content": "k" * n, "updatedAt": "2026-01-01T00:00:00.000Z", "status": "unverified", "provenance": ["src-%d" % i]}
def run(payload):
 r = subprocess.run(["bash", script], input=json.dumps(payload), capture_output=True, text=True)
 return r.returncode, json.loads(r.stdout)
code, out = run({"query": "venue", "broker": {"query": "venue", "results": [hit(1), hit(2)]}})
assert code == 0 and out["count"] == 2 and out["results"][0]["sourceId"] == "src-1" and "claims" in out["note"], out
code, out = run({"query": "venue", "limit": 1, "broker": {"query": "venue", "results": [hit(1), hit(2)]}})
assert code == 0 and out["count"] == 1, out
code, out = run({"query": "venue", "broker": {"query": "venue", "results": [hit(i, 5000) for i in range(5)]}})
assert code == 0 and all(len(r["text"]) == 1500 for r in out["results"]) and out["count"] == 4, out
code, out = run({"query": "venue"})
assert code == 2 and "error" in out, out
print("knowledge.search: ok")
CHECKS
