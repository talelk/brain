#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, subprocess, sys
script = sys.argv[1]
ops = {"summary": "Investigate the deployment", "blockers": ["Root cause unknown"], "nextActions": ["Read error logs"]}
support = {"summary": "Session expired", "missingInformation": ["Timestamp"], "risk": "low", "proposedReply": "Please share the timestamp."}
cases = [
 ("agent-smoke", "BRAIN_OK", True), ("agent-smoke", "WRONG", False),
 ("operations-triage", ops, True), ("support-draft", support, True),
 ("operations-triage", {**ops, "observations": ["Extra model field"]}, False),
 ("operations-triage", {**ops, "actions": ["Deploy"]}, False),
 ("operations-triage", {**ops, "nextActions": "Read logs"}, False),
 ("support-draft", {**support, "sent": True}, False),
 ("support-draft", {**support, "risk": "unknown"}, False),
 ("support-draft", {"summary": "Missing required fields"}, False),
]
for kind, report, expected in cases:
 result = subprocess.run(["bash", script], input=json.dumps({"kind": kind, "report": report}), text=True, capture_output=True, check=True)
 assert json.loads(result.stdout)["passed"] == expected, (kind, report, result.stdout)
print(f"Starter validator: {len(cases)} contract and rejection cases passed")
CHECKS
