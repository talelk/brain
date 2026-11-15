#!/usr/bin/env bash
set -euo pipefail
# The broker (the runner supervisor) asked the trusted launcher to run one operator-declared, read-only host command BY NAME (the
# launcher owns the argv; an agent supplies only the name and validated arguments) and supplies the result under "broker". This pinned
# script only bounds the text and redacts secret-looking values before the model sees it.
exec python3 -c '
import json, re, sys
v = json.load(sys.stdin)
b = v.get("broker")
if not isinstance(b, dict) or any(k not in b for k in ("command", "exitCode", "stdout", "stderr", "timedOut")):
 print(json.dumps({"error": "the broker supplied no command result"})); sys.exit(2)
SECRET = re.compile(r"(?i)^(\s*[\w.\"-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential)[\w.\"-]*\s*[:=]\s*)(\S.*)$")
BEARER = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}")
def clean(text, limit):
 text = "\n".join(SECRET.sub(lambda m: m.group(1) + "[redacted]", line) for line in str(text).split("\n"))
 text = BEARER.sub(lambda m: m.group(1) + "[redacted]", text)
 return text[:limit], len(text) > limit
out, cut_out = clean(b["stdout"], 12000)
err, cut_err = clean(b["stderr"], 2000)
print(json.dumps({"command": b["command"], "exitCode": int(b["exitCode"]), "output": out, "errorOutput": err, "timedOut": bool(b["timedOut"]), "truncated": cut_out or cut_err}))
'
