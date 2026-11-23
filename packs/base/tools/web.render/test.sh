#!/usr/bin/env bash
set -euo pipefail
# Proves the refusals of run.sh without a browser or a network: each bad input is refused before a page is opened.

here="$(cd "$(dirname "$0")" && pwd)"
python3 - "$here/run.sh" <<'CHECKS'
import json, subprocess, sys

script = sys.argv[1]

def run(payload):
    r = subprocess.run(["bash", script], input=payload if isinstance(payload, str) else json.dumps(payload), capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout)

for bad in ["not json", "[]", {}, {"url": "http://example.test"}, {"url": "https://user:pw@example.test"}, {"url": "https://example.test/a b"},
            {"url": "https://example.test", "max_chars": 0}, {"url": "https://example.test", "max_chars": True},
            {"url": "https://example.test", "wait_ms": 15001}, {"url": "https://example.test", "wait_ms": -1}, {"url": "file:///etc/passwd"}]:
    code, out = run(bad)
    assert code == 2 and "error" in out, (bad, code, out)
print("web.render: ok")
CHECKS
