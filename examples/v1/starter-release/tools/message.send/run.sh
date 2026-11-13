#!/usr/bin/env bash
set -euo pipefail
# The Governor performed this approved call with its own credentials and supplies the answer under "broker". This pinned script keeps
# only the fields below, so nothing else (and never a credential) can reach the model.
exec python3 -c '
import json, sys
v = json.load(sys.stdin)
b = v.get("broker")
if not isinstance(b, dict):
 print(json.dumps({"error": "the broker supplied no result"})); sys.exit(2)
keep = ["delivered"]
out = {k: b[k] for k in keep if k in b}
missing = [k for k in ["delivered"] if k not in out]
if missing:
 print(json.dumps({"error": "the broker result lacks " + ", ".join(missing)})); sys.exit(2)
print(json.dumps(out))
'
