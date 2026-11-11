#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, subprocess, sys
script = sys.argv[1]
broker = {"documentId": "doc-1", "title": "Notes", "revision": 2, "mediaType": "text/plain", "digest": "sha256:" + "a" * 64, "text": "x" * 100}
def run(payload):
 r = subprocess.run(["bash", script], input=json.dumps(payload), capture_output=True, text=True)
 return r.returncode, json.loads(r.stdout)
code, out = run({"documentId": "doc-1", "broker": broker})
assert code == 0 and out["text"] == "x" * 100 and out["truncated"] is False, out
code, out = run({"documentId": "doc-1", "maxChars": 10, "broker": broker})
assert code == 0 and out["text"] == "x" * 10 and out["truncated"] is True, out
code, out = run({"documentId": "doc-1", "maxChars": 10_000_000, "broker": broker})
assert code == 0 and len(out["text"]) == 100, out
code, out = run({"documentId": "doc-1"})
assert code == 2 and "error" in out, out
print("documents.read: ok")
CHECKS
