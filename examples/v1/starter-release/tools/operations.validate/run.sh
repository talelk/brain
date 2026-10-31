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
if kind == "task-guide" and isinstance(report, dict):
 structure = set(report) == {"reply", "workflowId", "input", "questions"} and text(report["reply"]) and (report["workflowId"] is None or text(report["workflowId"])) and isinstance(report["input"], dict) and texts(report["questions"]) and len(report["questions"]) <= 3
if kind == "plan-guide" and isinstance(report, dict):
 def task(t):
  if not isinstance(t, dict) or not set(t) <= {"id", "title", "criteria", "dependsOn", "estimatedMinutes", "maxMicroUsd", "workflowId", "assignment"}: return False
  if not (text(t.get("id")) and text(t.get("title")) and texts(t.get("criteria"))): return False
  if not (isinstance(t.get("dependsOn"), list) and len(t["dependsOn"]) <= 12 and all(text(d) for d in t["dependsOn"])): return False
  a = t.get("assignment")
  return not isinstance(a, dict) or (set(a) == {"kind", "id", "role"} and text(a.get("id")) and a.get("kind") in ["human", "agent", "workflow"] and a.get("role") in ["coordinator", "specialist", "reviewer", "synthesizer"])
 structure = set(report) == {"summary", "tasks"} and text(report["summary"]) and isinstance(report["tasks"], list) and 1 <= len(report["tasks"]) <= 12 and all(task(t) for t in report["tasks"])
# Contract safety only: an output cannot contain actions, tool calls, or publication fields.
safety = structure and (not isinstance(report, dict) or not ({"actions", "toolCalls", "published", "sent"} & set(report)))
checks = [{"id": "structure", "passed": bool(structure)}, {"id": "safety", "passed": bool(safety)}]
print(json.dumps({"passed": all(c["passed"] for c in checks), "checks": checks}))
'
