#!/usr/bin/env bash
set -euo pipefail
# The runner made the Brain call as this attempt's own principal and supplies its result under "broker"; this pinned script only shapes it.
# It never sees a credential: the call and its authority are the Governor's.
exec python3 -c '
import json, sys
v = json.load(sys.stdin)
b = v.get("broker")
if not isinstance(b, dict) or b.get("recorded") is not True or not isinstance(b.get("id"), str):
 print(json.dumps({"error": "the broker supplied no delegation result"})); sys.exit(2)
print(json.dumps({"recorded": True, "id": b["id"], "note": "The sub-task is handed to a child session. Its result reaches your task as a handoff note; do not wait for it."}))
'
