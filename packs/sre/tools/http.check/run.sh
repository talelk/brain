#!/usr/bin/env bash
set -euo pipefail
# http.check: one GET to one address; reports whether it answered.
#   stdin:  {"url": "https://host/health"}
#   stdout: {"url", "ok", "status", "time_ms"} plus "redirect" or "error" when they apply
# No answer (refused, timed out, host not allowed) is a finding, not a tool failure:
# it prints ok=false, status=0 and the reason, and exits 0.
# A refused input prints {"error": "..."} and exits 2.
# The tool sandbox's egress proxy decides which hosts answer (the tool's `network` list).

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
if not re.fullmatch(r"https?://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?([/?#][\x21-\x7e]*)?", url):
    out("error", "url must be a plain http or https address: no other scheme, no user or password, no spaces")
out("ok", url)
')"
IFS=$'\t' read -r kind value <<<"$parsed"
[ "$kind" = "ok" ] || fail "${value:-the input was refused}"
url="$value"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

set +e
meta="$(curl -q --silent --show-error \
  --proto '=http,https' --max-time 10 \
  --user-agent 'brain-http-check/1' \
  --output /dev/null \
  --write-out '%{http_code}\t%{time_total}\t%{redirect_url}' \
  -- "$url" 2>"$work/err")"
code=$?
set -e

META="$meta" python3 - "$url" "$code" "$work/err" <<'PY'
import json, os, sys

url, code, err_path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
parts = os.environ.get("META", "").split("\t")
status = int(parts[0]) if parts[0].isdigit() else 0
try:
    time_ms = int(round(float(parts[1]) * 1000)) if len(parts) > 1 else 0
except ValueError:
    time_ms = 0
redirect = parts[2].strip() if len(parts) > 2 else ""

if code != 0:
    with open(err_path, "r", errors="replace") as handle:
        reason = " ".join(handle.read(300).split())
    result = {"url": url, "ok": False, "status": 0, "time_ms": time_ms,
              "error": "no answer (curl exit %d): %s" % (code, reason or "no detail")}
else:
    result = {"url": url, "ok": 200 <= status <= 399, "status": status, "time_ms": time_ms}
    if redirect:
        result["redirect"] = redirect
print(json.dumps(result))
PY
