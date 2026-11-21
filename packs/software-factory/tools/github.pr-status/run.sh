#!/usr/bin/env bash
set -euo pipefail
# github.pr-status: see tool.toml. Reads one JSON object on stdin, writes one on stdout.
# A refused input or a failed call prints {"error": "..."} and exits 2.
# The GitHub secret arrives as BRAIN_SECRET_GITHUB and is never put in an argument or an output.

exec python3 -I -c '

import json, os, re, subprocess, sys, tempfile

def fail(why):
    print(json.dumps({"error": why}))
    sys.exit(2)

try:
    v = json.load(sys.stdin)
except ValueError:
    fail("the input is not JSON")
if not isinstance(v, dict):
    fail("the input must be a JSON object")
repo = v.get("repo")
if not isinstance(repo, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}", repo):
    fail("repo must be owner/name")
if any(part.strip(".") == "" for part in repo.split("/")):
    fail("repo must be owner/name")
number = v.get("number")
if isinstance(number, bool) or not isinstance(number, int) or number < 1:
    fail("number must be a whole number from 1")
token = os.environ.get("BRAIN_SECRET_GITHUB", "")
if not token:
    fail("the github secret is not available to this tool")

def api(method, path, body=None):
    """One call to the GitHub API; returns (status, parsed JSON or None). The token never appears in an argument."""
    with tempfile.TemporaryDirectory() as tmp:
        header = os.path.join(tmp, "header")
        with open(header, "w") as handle:
            handle.write("Authorization: Bearer " + token + "\n")
        out = os.path.join(tmp, "body")
        cmd = ["curl", "-q", "--silent", "--show-error", "--proto", "=https", "--max-time", "20", "--max-filesize", "5000000",
               "--user-agent", "brain-github-tool/1", "--request", method,
               "--header", "@" + header, "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2022-11-28",
               "--output", out, "--write-out", "%{http_code}"]
        data = None
        if body is not None:
            cmd += ["--header", "Content-Type: application/json", "--data-binary", "@-"]
            data = json.dumps(body)
        cmd += ["--", "https://api.github.com/repos/" + repo + path]
        r = subprocess.run(cmd, input=data, capture_output=True, text=True)
        if r.returncode != 0:
            fail("the request failed (curl exit %d): %s" % (r.returncode, r.stderr[:200].replace("\n", " ").strip() or "no detail"))
        status = int(r.stdout.strip() or 0)
        try:
            with open(out) as handle:
                parsed = json.loads(handle.read() or "null")
        except ValueError:
            parsed = None
        return status, parsed

def need(status, parsed, ok=(200, 201)):
    if status not in ok:
        message = parsed.get("message") if isinstance(parsed, dict) else None
        fail("GitHub answered %d%s" % (status, ": " + str(message)[:200] if message else ""))
    return parsed

def cut(text, n=8000):
    text = text or ""
    return text if len(text) <= n else text[:n] + "[cut: %d more characters]" % (len(text) - n)

def who(user):
    return (user or {}).get("login", "")

pr = need(*api("GET", "/pulls/%d" % number))
sha = pr["head"]["sha"]
runs = need(*api("GET", "/commits/%s/check-runs?per_page=100" % sha)).get("check_runs", [])
reviews = need(*api("GET", "/pulls/%d/reviews?per_page=100" % number))
latest = {}
for r in reviews:
    if r.get("state") != "PENDING":
        latest[who(r.get("user"))] = r.get("state", "")
print(json.dumps({
    "number": pr["number"], "title": pr["title"], "state": pr["state"], "merged": bool(pr.get("merged")), "draft": bool(pr.get("draft")),
    "mergeable": pr.get("mergeable"), "head_sha": sha,
    "checks": [{"name": c["name"], "status": c["status"], "conclusion": c.get("conclusion")} for c in runs],
    "reviews": [{"author": a, "state": s} for a, s in latest.items()],
}))
'
