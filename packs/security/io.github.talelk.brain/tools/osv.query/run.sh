#!/usr/bin/env bash
set -euo pipefail
# osv.query: see tool.toml. Reads one JSON object on stdin, writes one on stdout.
# A refused input or a failed call prints {"error": "..."} and exits 2. It needs no secret.

exec python3 -I -c '

import json, re, subprocess, sys, tempfile, os

def fail(why):
    print(json.dumps({"error": why}))
    sys.exit(2)

try:
    v = json.load(sys.stdin)
except ValueError:
    fail("the input is not JSON")
if not isinstance(v, dict):
    fail("the input must be a JSON object")

def text(key, pattern, what):
    value = v.get(key)
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        fail(key + " must be " + what)
    return value

ecosystem = text("ecosystem", r"[A-Za-z0-9._:-]{1,40}", "an OSV ecosystem name, such as npm or PyPI")
name = text("name", r"[A-Za-z0-9@/._+:-]{1,214}", "a package name")
version = text("version", r"[A-Za-z0-9._+:~!-]{1,80}", "an exact version")

with tempfile.TemporaryDirectory() as tmp:
    out = os.path.join(tmp, "body")
    cmd = ["curl", "-q", "--silent", "--show-error", "--proto", "=https", "--max-time", "20", "--max-filesize", "5000000",
           "--user-agent", "brain-osv-tool/1", "--request", "POST", "--header", "Content-Type: application/json",
           "--data-binary", "@-", "--output", out, "--write-out", "%{http_code}", "--", "https://api.osv.dev/v1/query"]
    r = subprocess.run(cmd, input=json.dumps({"package": {"ecosystem": ecosystem, "name": name}, "version": version}), capture_output=True, text=True)
    if r.returncode != 0:
        fail("the request failed (curl exit %d): %s" % (r.returncode, r.stderr[:200].replace("\n", " ").strip() or "no detail"))
    status = int(r.stdout.strip() or 0)
    try:
        with open(out) as handle:
            body = json.loads(handle.read() or "null")
    except ValueError:
        body = None
if status != 200 or not isinstance(body, dict):
    message = body.get("message") if isinstance(body, dict) else None
    fail("OSV answered %d%s" % (status, ": " + str(message)[:200] if message else ""))

def fixed(vuln):
    for affected in vuln.get("affected", []):
        if affected.get("package", {}).get("name") != name:
            continue
        for rng in affected.get("ranges", []):
            for event in rng.get("events", []):
                if "fixed" in event:
                    return event["fixed"]
    return None

result = []
for vuln in body.get("vulns", []):
    item = {"id": vuln["id"], "summary": (vuln.get("summary") or vuln.get("details") or "")[:300]}
    severity = (vuln.get("database_specific") or {}).get("severity")
    if severity:
        item["severity"] = str(severity)
    version_fixed = fixed(vuln)
    if version_fixed:
        item["fixed_in"] = version_fixed
    result.append(item)
print(json.dumps({"vulnerabilities": result}))
'
