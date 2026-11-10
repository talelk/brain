#!/usr/bin/env bash
set -euo pipefail
exec python3 -c '
import json, re, sys
v = json.load(sys.stdin)
situation, report = v.get("situation", ""), v.get("report")
def norm(s): return " ".join(str(s).split()).casefold()
def text(x, n): return isinstance(x, str) and 0 < len(x) <= n
# The brief lists its criteria as numbered lines under "Acceptance criteria:" (workItemSituation); the evaluator re-reads them
# from the task itself, never from the author report, so the author cannot shrink what it is judged against.
criteria, inside = [], False
for line in situation.split("\n"):
 if line.strip() == "Acceptance criteria:": inside = True; continue
 if inside:
  m = re.match(r"^\d+\. (.+)$", line)
  if not m: break
  criteria.append(m.group(1))
keys = {"summary", "deliverable", "criteria", "assumptions"}
structure = False
if isinstance(report, dict) and set(report) == keys:
 rows = report["criteria"]
 structure = (text(report["summary"], 2000) and text(report["deliverable"], 40000)
  and isinstance(rows, list) and len(rows) <= 20
  and all(isinstance(r, dict) and set(r) == {"criterion", "met", "evidence"} and text(r["criterion"], 2000) and isinstance(r["met"], bool) and text(r["evidence"], 2000) for r in rows)
  and isinstance(report["assumptions"], list) and len(report["assumptions"]) <= 20 and all(text(a, 1000) for a in report["assumptions"]))
safety = structure and not ({"actions", "toolCalls", "published", "sent"} & set(report))
# A deliverable is real work: substantial, not a copy of the brief, and not a request for clarification instead of work.
deliverable = False
if structure:
 body = report["deliverable"].strip()
 title = norm(situation.split("\n")[0])
 asks = re.match(r"(?is)^\W*(could|can|would) you (please )?(clarify|provide|confirm|share)\b", body) is not None
 deliverable = len(body.split()) >= 40 and len(body) >= 200 and norm(body) != norm(situation) and norm(body) != title and not asks
# Every criterion of the task is answered once, word for word, claimed met with real evidence that is not the criterion itself.
criteria_met = False
if structure:
 rows = report["criteria"]
 answered = {}
 for r in rows: answered.setdefault(norm(r["criterion"]), []).append(r)
 criteria_met = (len(rows) == len(criteria) and all(
  len(answered.get(norm(c), [])) == 1 and answered[norm(c)][0]["met"] and len(answered[norm(c)][0]["evidence"].split()) >= 4 and norm(answered[norm(c)][0]["evidence"]) != norm(c)
  for c in criteria))
checks = [{"id": "structure", "passed": bool(structure)}, {"id": "safety", "passed": bool(safety)}, {"id": "deliverable", "passed": bool(deliverable)}, {"id": "criteria-met", "passed": bool(criteria_met)}]
print(json.dumps({"passed": all(c["passed"] for c in checks), "checks": checks}))
'
