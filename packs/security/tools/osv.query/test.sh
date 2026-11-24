#!/usr/bin/env bash
set -euo pipefail
# Proves run.sh without any network: a stub `curl`, first on PATH, answers from a table of
# package names and records every call.

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"

cat >"$tmp/bin/curl" <<'STUB'
#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
out = url = None
i = 0
while i < len(args):
    a = args[i]
    if a == "--output": out = args[i + 1]; i += 2
    elif a == "--": url = args[i + 1]; i += 2
    elif a in ("--request", "--header", "--data-binary", "--max-time", "--max-filesize", "--user-agent", "--proto", "--write-out"): i += 2
    else: i += 1
stdin = sys.stdin.read()
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps({"url": url, "stdin": stdin}) + "\n")
assert url == "https://api.osv.dev/v1/query", url
name = json.loads(stdin)["package"]["name"]
status, body = json.loads(os.environ["FAKE_ROUTES"]).get(name, [404, {"message": "no route " + name}])
open(out, "w").write(json.dumps(body))
sys.stdout.write(str(status))
STUB
chmod +x "$tmp/bin/curl"

PATH="$tmp/bin:$PATH" python3 - "$here/run.sh" "$tmp" <<'CHECKS'
import json, os, subprocess, sys

script, tmp = sys.argv[1], sys.argv[2]
log = os.path.join(tmp, "calls")

def run(payload, routes):
    if os.path.exists(log):
        os.remove(log)
    env = {**os.environ, "FAKE_LOG": log, "FAKE_ROUTES": json.dumps(routes)}
    r = subprocess.run(["bash", script], input=payload if isinstance(payload, str) else json.dumps(payload), capture_output=True, text=True, env=env)
    calls = [json.loads(line) for line in open(log)] if os.path.exists(log) else []
    return r.returncode, json.loads(r.stdout), calls

ROUTES = {
    "lodash": [200, {"vulns": [
        {"id": "GHSA-1", "summary": "Prototype pollution", "database_specific": {"severity": "HIGH"},
         "affected": [{"package": {"name": "lodash"}, "ranges": [{"events": [{"introduced": "0"}, {"fixed": "4.17.21"}]}]}]},
        {"id": "GHSA-2", "details": "Something else"}]}],
    "clean": [200, {}],
    "boom": [500, {"message": "down"}],
}
good = {"ecosystem": "npm", "name": "lodash", "version": "4.17.0"}
code, out, calls = run(good, ROUTES)
assert code == 0, out
assert out == {"vulnerabilities": [
    {"id": "GHSA-1", "summary": "Prototype pollution", "severity": "HIGH", "fixed_in": "4.17.21"},
    {"id": "GHSA-2", "summary": "Something else"}]}, out
assert json.loads(calls[0]["stdin"]) == {"package": {"ecosystem": "npm", "name": "lodash"}, "version": "4.17.0"}, calls
code, out, _ = run({**good, "name": "clean"}, ROUTES)
assert code == 0 and out == {"vulnerabilities": []}, out
code, out, _ = run({**good, "name": "boom"}, ROUTES)
assert code == 2 and "500" in out["error"], out

# Bad input never reaches the network.
for bad in [{**good, "name": "a b"}, {**good, "ecosystem": ""}, {**good, "version": 1}, {"ecosystem": "npm", "name": "x"}, {}, "not json", "[]"]:
    code, out, calls = run(bad, ROUTES)
    assert code == 2 and "error" in out and calls == [], (bad, out, calls)

print("osv.query: ok")
CHECKS
