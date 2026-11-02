#!/usr/bin/env bash
set -euo pipefail
exec python3 -c '
import json, sys
json.load(sys.stdin)
print(json.dumps({"observations": ["The local diagnostic environment is reachable."], "limitations": ["No customer production system is connected to this read-only context tool."]}))
'
