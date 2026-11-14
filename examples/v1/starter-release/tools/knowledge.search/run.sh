#!/usr/bin/env bash
set -euo pipefail
# The broker (the Governor, after it fixed the scope to the mission's workspace) supplies ranked hits under "broker".
# This pinned script only bounds them and labels how far to trust them.
exec python3 -c '
import json, sys
v = json.load(sys.stdin)
b = v.get("broker")
if not isinstance(b, dict) or not isinstance(b.get("results"), list):
 print(json.dumps({"error": "the broker supplied no search results"})); sys.exit(2)
limit = v.get("limit", 5)
if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 10: limit = 5
results, used = [], 0
for hit in b["results"][:limit]:
 text = str(hit.get("content", ""))[:1500]
 if used + len(text) > 6000: break
 used += len(text)
 row = {"sourceId": hit.get("sourceId"), "text": text, "updatedAt": hit.get("updatedAt"), "status": hit.get("status", "unverified"), "provenance": hit.get("provenance", []), "claim": True}
 for key in ("sourceType", "title", "selfReviewed"):
  if key in hit: row[key] = hit[key]
 results.append(row)
print(json.dumps({
 "query": b.get("query", v.get("query")), "results": results, "count": len(results),
 "note": "Hits are claims from stored knowledge and earlier missions, never evidence of this task. Only status reviewed has been checked by a person; treat the rest as leads, cite the source and its provenance, and do not present a hit as something you observed.",
}))
'
