#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, subprocess, sys
script = sys.argv[1]
page = {"url": "https://example.test/a", "finalUrl": "https://example.test/a", "status": 200, "contentType": "text/html; charset=utf-8", "fetchedAt": "2026-01-01T00:00:00.000Z",
 "body": "<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>Hello  world</p></body></html>"}
def run(payload):
 r = subprocess.run(["bash", script], input=json.dumps(payload), capture_output=True, text=True)
 return r.returncode, json.loads(r.stdout)
code, out = run({"url": page["url"], "broker": page})
assert code == 0 and "alert" not in out["text"] and "Title" in out["text"] and "Hello world" in out["text"] and out["url"] == page["url"], out
code, out = run({"url": page["url"], "maxChars": 5, "broker": {**page, "contentType": "text/plain", "body": "abcdefghij"}})
assert code == 0 and out["text"] == "abcde" and out["truncated"] is True, out
code, out = run({"url": page["url"]})
assert code == 2 and "error" in out, out
print("web.fetch: ok")
CHECKS
