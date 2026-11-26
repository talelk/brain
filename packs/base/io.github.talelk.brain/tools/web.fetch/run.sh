#!/usr/bin/env bash
set -euo pipefail
# web.fetch: GET one https address and return its readable text.
#   stdin:  {"url": "https://host/path", "max_chars": 8000}
#   stdout: {"url", "final_url", "status", "content_type", "text", "truncated"}
# A refused input or a failed fetch prints {"error": "..."} and exits 2.
# The tool sandbox's egress proxy decides which hosts answer (the tool's `network` list).
# This script adds: https only, GET only, no credentials in the address, bounded size and time.

fail() {
  python3 -c 'import json, sys; print(json.dumps({"error": sys.argv[1]}))' "$1"
  exit 2
}

input="$(cat)"
parsed="$(printf '%s' "$input" | python3 -c '
import json, re, sys
def out(*parts):
    print("\t".join(str(p) for p in parts))
    sys.exit(0)
try:
    v = json.load(sys.stdin)
except ValueError:
    out("error", "the input is not JSON")
if not isinstance(v, dict):
    out("error", "the input must be a JSON object")
url = v.get("url")
if not isinstance(url, str) or not 1 <= len(url) <= 2000:
    out("error", "url must be text of at most 2000 characters")
if not re.fullmatch(r"https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?([/?#][\x21-\x7e]*)?", url):
    out("error", "url must be a plain https address: no other scheme, no user or password, no spaces")
limit = v.get("max_chars", 8000)
if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 20000:
    out("error", "max_chars must be a whole number from 1 to 20000")
out("ok", limit, url)
')"
IFS=$'\t' read -r kind first second <<<"$parsed"
[ "$kind" = "ok" ] || fail "${first:-the input was refused}"
limit="$first"
url="$second"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

set +e
meta="$(curl -q --silent --show-error --location --max-redirs 3 \
  --proto '=https' --proto-redir '=https' \
  --max-time 20 --max-filesize 2000000 \
  --user-agent 'brain-web-fetch/1' \
  --output "$work/body" \
  --write-out '%{http_code}\t%{url_effective}\t%{content_type}' \
  -- "$url" 2>"$work/err")"
code=$?
set -e
if [ "$code" -ne 0 ]; then
  reason="$(head -c 300 "$work/err" | tr '\n' ' ')"
  fail "the fetch failed (curl exit $code): ${reason:-no detail}"
fi
[ -f "$work/body" ] || : >"$work/body"

META="$meta" python3 - "$work/body" "$url" "$limit" <<'PY'
import html, json, os, re, sys

body_path, url, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
parts = os.environ.get("META", "").split("\t")
status = int(parts[0]) if parts[0].isdigit() else 0
final_url = parts[1] if len(parts) > 1 and parts[1] else url
content_type = parts[2] if len(parts) > 2 else ""

cap = 2000000
with open(body_path, "rb") as handle:
    raw = handle.read(cap + 1)
if b"\x00" in raw[:4096]:
    print(json.dumps({"error": "the address returned binary content, which this tool does not read"}))
    sys.exit(2)

text = raw[:cap].decode("utf-8", "replace")
if "html" in content_type.lower() or re.match(r"\s*<(!doctype|html)\b", text, re.I):
    text = re.sub(r"(?is)<(script|style|noscript|template)\b[^>]*>.*?</\1\s*>", " ", text)
    text = re.sub(r"(?s)<!--.*?-->", " ", text)
    text = re.sub(r"(?i)<(br|/p|/div|/li|/tr|/h[1-6])\b[^>]*>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()

print(json.dumps({
    "url": url,
    "final_url": final_url,
    "status": status,
    "content_type": content_type,
    "text": text[:limit],
    "truncated": len(raw) > cap or len(text) > limit,
}))
PY
