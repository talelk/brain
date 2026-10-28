#!/usr/bin/env bash
set -euo pipefail
exec python3 -c '
import json, sys
v = json.load(sys.stdin)
kind, report = v.get("kind"), v.get("report")
def text(x): return isinstance(x, str) and 0 < len(x) <= 10000
def texts(x): return isinstance(x, list) and len(x) <= 20 and all(text(i) for i in x)
structure = False
if kind == "agent-smoke": structure = report == "BRAIN_OK"
if kind == "operations-triage" and isinstance(report, dict):
 structure = set(report) == {"summary", "blockers", "nextActions"} and text(report["summary"]) and texts(report["blockers"]) and texts(report["nextActions"])
if kind == "support-draft" and isinstance(report, dict):
 structure = set(report) == {"summary", "missingInformation", "risk", "proposedReply"} and text(report["summary"]) and texts(report["missingInformation"]) and report["risk"] in ["low", "medium", "high"] and text(report["proposedReply"])
# Contract safety only: an output cannot contain actions, tool calls, or publication fields.
safety = structure and (not isinstance(report, dict) or not ({"actions", "toolCalls", "published", "sent"} & set(report)))
checks = [{"id": "structure", "passed": bool(structure)}, {"id": "safety", "passed": bool(safety)}]
print(json.dumps({"passed": all(c["passed"] for c in checks), "checks": checks}))
'
