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
# Every criterion of the task is answered once, claimed met with real evidence that is not the criterion itself. A row is
# matched to its criterion by normalised wording (case, spacing, punctuation and list numbers ignored); a row the model
# reworded is accepted at the position of its criterion, because the rows are required to follow the criteria in order.
def key(s): return " ".join(re.sub(r"[^\w]+", " ", re.sub(r"^\s*(\d+[.)]|[-*])\s+", "", str(s))).split()).casefold()
criteria_met = False
if structure:
 rows = report["criteria"]
 if len(rows) == len(criteria):
  picked, free_rows = {}, list(range(len(rows)))
  for i, c in enumerate(criteria):
   hit = next((j for j in free_rows if key(rows[j]["criterion"]) == key(c)), None)
   if hit is not None: picked[i] = hit; free_rows.remove(hit)
  keys = {key(c) for c in criteria}
  def close(a, b):
   x, y = {w for w in key(a).split() if len(w) > 2}, {w for w in key(b).split() if len(w) > 2}
   return bool(x and y) and len(x & y) / min(len(x), len(y)) >= 0.3
  reworded = True
  for i in range(len(criteria)):
   if i not in picked:
    j = free_rows.pop(0); picked[i] = j
    reworded = reworded and key(rows[j]["criterion"]) not in keys and close(rows[j]["criterion"], criteria[i])
  criteria_met = reworded and all(rows[picked[i]]["met"] and len(rows[picked[i]]["evidence"].split()) >= 4 and key(rows[picked[i]]["evidence"]) != key(c) for i, c in enumerate(criteria))
checks = [{"id": "structure", "passed": bool(structure)}, {"id": "safety", "passed": bool(safety)}, {"id": "deliverable", "passed": bool(deliverable)}, {"id": "criteria-met", "passed": bool(criteria_met)}]
print(json.dumps({"passed": all(c["passed"] for c in checks), "checks": checks}))
'
