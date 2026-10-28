#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
python3 -c 'import json,subprocess; r=subprocess.run(["bash","run.sh"],input=json.dumps({"report":{"message":"Brain fixture"}}),text=True,capture_output=True,check=True); assert json.loads(r.stdout)["passed"] is True; r=subprocess.run(["bash","run.sh"],input=json.dumps({"report":{"message":"wrong"}}),text=True,capture_output=True,check=True); assert json.loads(r.stdout)["passed"] is False; print("2 independent evaluator cases")'
