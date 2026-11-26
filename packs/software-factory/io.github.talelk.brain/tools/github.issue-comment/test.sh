#!/usr/bin/env bash
set -euo pipefail
# Proves run.sh without any network: a stub `curl`, first on PATH, answers from a table of
# "METHOD path" routes and records every call (method, arguments, standard input).

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"

cat >"$tmp/bin/curl" <<'STUB'
#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
out = method = url = None
i = 0
while i < len(args):
    a = args[i]
    if a == "--output": out = args[i + 1]; i += 2
    elif a == "--request": method = args[i + 1]; i += 2
    elif a == "--": url = args[i + 1]; i += 2
    elif a in ("--header", "--data-binary", "--max-time", "--max-filesize", "--user-agent", "--proto", "--write-out"): i += 2
    else: i += 1
header = open(args[args.index("--header") + 1][1:]).read()
assert header.strip() == "Authorization: Bearer tok-123", header
stdin = "" if sys.stdin.isatty() or "--data-binary" not in args else sys.stdin.read()
with open(os.environ["FAKE_LOG"], "a") as log:
    log.write(json.dumps({"method": method, "args": " ".join(args), "stdin": stdin}) + "\n")
assert url.startswith("https://api.github.com/repos/o/r"), url
route = method + " " + url[len("https://api.github.com/repos/o/r"):]
status, body = json.loads(os.environ["FAKE_ROUTES"]).get(route, [404, {"message": "no route " + route}])
open(out, "w").write(json.dumps(body))
sys.stdout.write(str(status))
STUB
chmod +x "$tmp/bin/curl"

PATH="$tmp/bin:$PATH" python3 - "$here/run.sh" "$tmp" <<'CHECKS'
import json, os, subprocess, sys

script, tmp = sys.argv[1], sys.argv[2]
log = os.path.join(tmp, "calls")

def run(payload, routes, token="tok-123"):
    if os.path.exists(log):
        os.remove(log)
    env = {**os.environ, "FAKE_LOG": log, "FAKE_ROUTES": json.dumps(routes)}
    env.pop("BRAIN_SECRET_GITHUB", None)
    if token:
        env["BRAIN_SECRET_GITHUB"] = token
    r = subprocess.run(["bash", script], input=payload if isinstance(payload, str) else json.dumps(payload), capture_output=True, text=True, env=env)
    calls = [json.loads(line) for line in open(log)] if os.path.exists(log) else []
    return r.returncode, json.loads(r.stdout), calls

ROUTES = {
    "POST /issues/7/comments": [201, {"id": 55, "html_url": "https://github.com/o/r/issues/7#issuecomment-55"}],
    "POST /issues/9/comments": [403, {"message": "Forbidden"}],
}
code, out, calls = run({"repo": "o/r", "number": 7, "body": "Thanks, looking."}, ROUTES)
assert code == 0 and out == {"id": 55, "url": "https://github.com/o/r/issues/7#issuecomment-55"}, out
assert calls[0]["stdin"] == json.dumps({"body": "Thanks, looking."}), calls
code, out, _ = run({"repo": "o/r", "number": 9, "body": "x"}, ROUTES)
assert code == 2 and "403" in out["error"], out
for bad in [{"repo": "o/r", "number": 7}, {"repo": "o/r", "number": 7, "body": "  "}, {"repo": "o/r", "number": 7, "body": "x" * 20001}]:
    code, out, calls = run(bad, ROUTES)
    assert code == 2 and calls == [], (bad, out)

# A missing secret, bad addresses and a payload that is not an object never reach the network.
for bad in [{"repo": "o/r", "number": 1}]:
    code, out, calls = run(bad, {}, token="")
    assert code == 2 and "secret" in out["error"] and calls == [], out
for bad in [{"repo": "o r", "number": 1}, {"repo": "../x", "number": 1}, {"repo": "o/r", "number": 0}, {"repo": "o/r", "number": "1"}, {}, "not json", "[]"]:
    code, out, calls = run(bad, {})
    assert code == 2 and "error" in out and calls == [], (bad, out, calls)

print("github.issue-comment: ok")
CHECKS
