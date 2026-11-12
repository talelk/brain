#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, os, subprocess, sys, tempfile
script = sys.argv[1]
root = tempfile.mkdtemp()
os.makedirs(root + "/demos/app/backups"); os.makedirs(root + "/demos/app/conf")
open(root + "/demos/app/README.md", "w").write("hello\nDB_PASSWORD=hunter2\nplain line\n")
open(root + "/demos/app/.env", "w").write("TOKEN=abc\n")
open(root + "/demos/app/data.db", "wb").write(b"SQLite")
open(root + "/demos/app/backups/x.txt", "w").write("old")
open(root + "/demos/app/blob.bin", "wb").write(b"\x00\x01\x02")
os.symlink("/etc/passwd", root + "/demos/app/escape")
os.symlink("../../../..", root + "/demos/app/up")
def run(payload):
 r = subprocess.run(["bash", script], input=json.dumps(payload), capture_output=True, text=True, env={**os.environ, "BRAIN_HOST_READ_ROOT": root})
 return r.returncode, json.loads(r.stdout)
code, out = run({"op": "list", "path": "demos/app"})
names = [e["name"] for e in out["entries"]]
assert code == 0 and "README.md" in names and ".env" not in names and "data.db" not in names and "backups" not in names and "escape" not in names and out["hidden"] >= 4, out
code, out = run({"op": "read", "path": "demos/app/README.md"})
assert code == 0 and "hello" in out["text"] and "hunter2" not in out["text"] and "[redacted]" in out["text"] and "plain line" in out["text"], out
for bad in ("demos/app/.env", "demos/app/data.db", "demos/app/backups/x.txt", "../etc/passwd", "demos/app/escape", "demos/app/up/etc/passwd", "demos/app/blob.bin"):
 code, out = run({"op": "read", "path": bad})
 assert code == 2 and "error" in out, (bad, out)
code, out = run({"op": "find", "path": "demos", "pattern": "*.md"})
assert code == 0 and out["matches"] == ["/demos/app/README.md"], out
code, out = run({"op": "read", "path": "demos/app/README.md", "maxBytes": 5})
assert code == 0 and out["truncated"] is True and len(out["text"]) <= 5, out
code, out = run({"op": "delete", "path": "x"})
assert code == 2, out
print("host.read: ok")
CHECKS
