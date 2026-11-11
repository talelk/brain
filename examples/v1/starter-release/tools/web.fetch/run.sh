#!/usr/bin/env bash
set -euo pipefail
# The broker (the runner supervisor) already fetched the page with GET only, from an allowlisted host, with size and time
# bounds, and supplies it under "broker". This pinned script only turns it into bounded readable text.
exec python3 -c '
import json, re, sys
v = json.load(sys.stdin)
b = v.get("broker")
needed = ("url", "finalUrl", "status", "contentType", "fetchedAt", "body")
if not isinstance(b, dict) or any(k not in b for k in needed) or not isinstance(b["body"], str):
 print(json.dumps({"error": "the broker supplied no fetched page"})); sys.exit(2)
limit = v.get("maxChars", 8000)
if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20000: limit = 8000
text = b["body"]
if "html" in b["contentType"].lower():
 text = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", text)
 text = re.sub(r"(?s)<[^>]+>", " ", text)
 text = re.sub(r"[ \t\r\f\v]+", " ", text)
 text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
print(json.dumps({
 "url": b["url"], "finalUrl": b["finalUrl"], "status": b["status"], "contentType": b["contentType"], "fetchedAt": b["fetchedAt"],
 "text": text[:limit], "truncated": bool(b.get("truncated")) or len(text) > limit,
}))
'
