#!/usr/bin/env bash
set -euo pipefail
# The broker (the runner supervisor, after the Governor rechecked workspace scope) supplies the document under "broker".
# This pinned script only bounds and shapes it; it has no network and no file access of its own.
exec python3 -c '
import json, sys
v = json.load(sys.stdin)
b = v.get("broker")
needed = ("documentId", "title", "revision", "mediaType", "digest", "text")
if not isinstance(b, dict) or any(k not in b for k in needed) or not isinstance(b["text"], str):
 print(json.dumps({"error": "the broker supplied no readable document"})); sys.exit(2)
limit = v.get("maxChars", 8000)
if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20000: limit = 8000
text = b["text"]
print(json.dumps({
 "documentId": b["documentId"], "title": b["title"], "revision": b["revision"], "mediaType": b["mediaType"], "digest": b["digest"],
 "text": text[:limit], "truncated": bool(b.get("truncated")) or len(text) > limit,
}))
'
