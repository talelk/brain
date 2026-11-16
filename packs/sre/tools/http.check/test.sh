#!/usr/bin/env bash
set -euo pipefail
# Proves run.sh without any network: a stub `curl`, first on PATH, answers what the test
# tells it to and records how it was called.

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"

cat >"$tmp/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_CURL_LOG"
if [ "${FAKE_CURL_EXIT:-0}" != "0" ]; then
  echo "curl: (7) Failed to connect to host" >&2
  printf '000\t0.000000\t'
  exit "$FAKE_CURL_EXIT"
fi
printf '%s\t%s\t%s' "${FAKE_CURL_STATUS:-200}" "${FAKE_CURL_TIME:-0.123456}" "${FAKE_CURL_REDIRECT:-}"
STUB
chmod +x "$tmp/bin/curl"

PATH="$tmp/bin:$PATH" python3 - "$here/run.sh" "$tmp" <<'CHECKS'
import json, os, subprocess, sys

script, tmp = sys.argv[1], sys.argv[2]
log = os.path.join(tmp, "calls")

def run(payload, **env):
    if os.path.exists(log):
        os.remove(log)
    r = subprocess.run(
        ["bash", script],
        input=payload if isinstance(payload, str) else json.dumps(payload),
        capture_output=True, text=True,
        env={**os.environ, "FAKE_CURL_LOG": log, **env},
    )
    calls = open(log).read() if os.path.exists(log) else ""
    return r.returncode, json.loads(r.stdout), calls

# A healthy address: ok, status and time; one GET, no redirect followed, address after "--".
code, out, calls = run({"url": "https://app.example.test/health"})
assert code == 0 and out == {"url": "https://app.example.test/health", "ok": True, "status": 200, "time_ms": 123}, out
assert "--location" not in calls and "--proto =http,https" in calls and calls.rstrip().endswith("-- https://app.example.test/health"), calls

# Plain http is allowed (internal health addresses).
code, out, _ = run({"url": "http://10.0.0.5:8080/ready"}, FAKE_CURL_STATUS="204")
assert code == 0 and out["ok"] is True and out["status"] == 204, out

# A server error is a finding: ok=false, exit 0.
code, out, _ = run({"url": "https://app.example.test/health"}, FAKE_CURL_STATUS="502")
assert code == 0 and out["ok"] is False and out["status"] == 502 and "error" not in out, out

# A redirect is reported, not followed.
code, out, _ = run({"url": "https://app.example.test/"}, FAKE_CURL_STATUS="302", FAKE_CURL_REDIRECT="https://app.example.test/login")
assert code == 0 and out["ok"] is True and out["redirect"] == "https://app.example.test/login", out

# No answer at all is also a finding: ok=false, status 0, the reason, exit 0.
code, out, _ = run({"url": "https://down.example.test/"}, FAKE_CURL_EXIT="7")
assert code == 0 and out["ok"] is False and out["status"] == 0 and "curl exit 7" in out["error"] and "Failed to connect" in out["error"], out

# Refused inputs never reach curl.
refused = [
    {"url": "ftp://example.test/"},
    {"url": "file:///etc/passwd"},
    {"url": "https://user:pw@example.test/"},
    {"url": "https://example.test/a b"},
    {"url": "-o /tmp/x https://example.test/"},
    {"url": ""},
    {"url": 7},
    {},
    "not json",
    "[]",
]
for payload in refused:
    code, out, calls = run(payload)
    assert code == 2 and "error" in out and calls == "", (payload, out, calls)

print("http.check: ok")
CHECKS
