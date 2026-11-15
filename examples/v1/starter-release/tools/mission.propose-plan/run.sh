#!/usr/bin/env bash
set -euo pipefail
# The runner made the Brain call as this attempt's own principal and supplies its result under "broker"; this pinned script only shapes it.
# It never sees a credential: the call and its authority are the Governor's.
exec python3 -c '
import json, sys
v = json.load(sys.stdin)
b = v.get("broker")
if not isinstance(b, dict) or b.get("recorded") is not True or not isinstance(b.get("planVersionId"), str):
 print(json.dumps({"error": "the broker supplied no plan result"})); sys.exit(2)
print(json.dumps({"recorded": True, "planVersionId": b["planVersionId"], "state": str(b.get("state", "proposed")), "outcome": str(b.get("outcome", ""))[:600]}))
'
