#!/usr/bin/env bash
set -euo pipefail
# Proves run.sh without any network: a stub `curl`, first on PATH, answers from a local
# file and records how it was called.

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"

cat >"$tmp/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_CURL_LOG"
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --) url="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "${FAKE_CURL_EXIT:-0}" != "0" ]; then
  echo "curl: (6) Could not resolve host" >&2
  exit "$FAKE_CURL_EXIT"
fi
cp "$FAKE_CURL_BODY" "$out"
printf '%s\t%s\t%s' "${FAKE_CURL_STATUS:-200}" "$url" "${FAKE_CURL_TYPE-text/html; charset=utf-8}"
STUB
chmod +x "$tmp/bin/curl"

PATH="$tmp/bin:$PATH" python3 - "$here/run.sh" "$tmp" <<'CHECKS'
import json, os, subprocess, sys

script, tmp = sys.argv[1], sys.argv[2]
log = os.path.join(tmp, "calls")
body = os.path.join(tmp, "body")

def run(payload, content=b"", **env):
    with open(body, "wb") as handle:
        handle.write(content)
    if os.path.exists(log):
        os.remove(log)
    r = subprocess.run(
        ["bash", script],
        input=payload if isinstance(payload, str) else json.dumps(payload),
        capture_output=True, text=True,
        env={**os.environ, "FAKE_CURL_LOG": log, "FAKE_CURL_BODY": body, **env},
    )
    calls = open(log).read() if os.path.exists(log) else ""
    return r.returncode, json.loads(r.stdout), calls

page = b"<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>Hello  world &amp; all</p></body></html>"

# An HTML page becomes text; curl is called https-only with the address after "--".
code, out, calls = run({"url": "https://example.test/a?b=1"}, page)
assert code == 0, out
assert "alert" not in out["text"] and "Title" in out["text"] and "Hello world & all" in out["text"], out
assert out["url"] == "https://example.test/a?b=1" and out["final_url"] == out["url"], out
assert out["status"] == 200 and out["truncated"] is False, out
assert "--proto =https" in calls and "--proto-redir =https" in calls and calls.rstrip().endswith("-- https://example.test/a?b=1"), calls

# Plain text is returned as is and cut at max_chars.
code, out, _ = run({"url": "https://example.test/t", "max_chars": 5}, b"abcdefghij", FAKE_CURL_TYPE="text/plain")
assert code == 0 and out["text"] == "abcde" and out["truncated"] is True, out

# A non-2xx answer is reported, not hidden.
code, out, _ = run({"url": "https://example.test/missing"}, b"not found", FAKE_CURL_TYPE="text/plain", FAKE_CURL_STATUS="404")
assert code == 0 and out["status"] == 404 and out["text"] == "not found", out

# Binary content is refused.
code, out, _ = run({"url": "https://example.test/bin"}, b"\x00\x01\x02", FAKE_CURL_TYPE="application/octet-stream")
assert code == 2 and "binary" in out["error"], out

# A failed fetch (for example a host the proxy refuses) is an error with curl's reason.
code, out, _ = run({"url": "https://blocked.test/"}, b"", FAKE_CURL_EXIT="6")
assert code == 2 and "curl exit 6" in out["error"] and "resolve" in out["error"], out

# Refused inputs never reach curl.
refused = [
    {"url": "http://example.test/"},
    {"url": "file:///etc/passwd"},
    {"url": "https://user:pw@example.test/"},
    {"url": "https://example.test/a b"},
    {"url": "--output /tmp/x https://example.test/"},
    {"url": "https://example.test/", "max_chars": 0},
    {"url": "https://example.test/", "max_chars": "many"},
    {"url": 7},
    {},
    "not json",
    "[]",
]
for payload in refused:
    code, out, calls = run(payload, page)
    assert code == 2 and "error" in out and calls == "", (payload, out, calls)

print("web.fetch: ok")
CHECKS
