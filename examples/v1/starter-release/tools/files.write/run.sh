#!/usr/bin/env bash
set -euo pipefail
# The broker (the runner supervisor) wrote the file into the attempt's output folder and reports what it did under "broker".
# This pinned script only shapes that report; it has no network and no file access of its own, and never sees the file's text.
exec python3 -c '
import json, sys
v = json.load(sys.stdin)
b = v.get("broker")
needed = ("name", "bytes", "files", "totalBytes", "replaced")
if not isinstance(b, dict) or any(k not in b for k in needed):
 print(json.dumps({"error": "the broker wrote no file"})); sys.exit(2)
print(json.dumps({k: b[k] for k in needed}))
'
