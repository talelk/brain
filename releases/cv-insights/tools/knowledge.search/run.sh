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
 results.append({"sourceId": hit.get("sourceId"), "text": text, "updatedAt": hit.get("updatedAt"), "status": hit.get("status", "unverified"), "provenance": hit.get("provenance", [])})
print(json.dumps({
 "query": b.get("query", v.get("query")), "results": results, "count": len(results),
 "note": "Hits are claims from stored knowledge. Only status reviewed has been checked by a person; treat the rest as leads and say where a fact came from.",
}))
'
