#!/usr/bin/env bash
set -euo pipefail
# github.label: see tool.toml. Reads one JSON object on stdin, writes one on stdout.
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

def names(key):
    value = v.get(key, [])
    if not isinstance(value, list) or len(value) > 10 or not all(isinstance(x, str) and 1 <= len(x) <= 50 and "/" not in x and "\n" not in x for x in value):
        fail(key + " must be a list of at most 10 label names")
    return value
add, remove = names("add"), names("remove")
if not add and not remove:
    fail("give at least one label to add or remove")
if set(add) & set(remove):
    fail("a label cannot be both added and removed")
from urllib.parse import quote
for name in remove:
    s, parsed = api("DELETE", "/issues/%d/labels/%s" % (number, quote(name, safe="")))
    if s != 404:
        need(s, parsed)
if add:
    need(*api("POST", "/issues/%d/labels" % number, {"labels": add}))
labels = need(*api("GET", "/issues/%d/labels?per_page=100" % number))
print(json.dumps({"labels": [l["name"] for l in labels]}))
'
