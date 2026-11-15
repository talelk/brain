#!/usr/bin/env bash
set -euo pipefail
# Read-only view of the host's /srv, mounted by the operator at /data/srv (BRAIN_LAUNCHER_DATA_MOUNTS) and offered to this tool only
# (BRAIN_TOOL_DATA_MOUNTS). The mount is read-only; this script adds the rules an agent cannot talk its way around: no path outside the
# mount (symlinks included), no secret-bearing or backup files, text only, bounded output, secret-looking values redacted.
exec python3 -c '
import fnmatch, json, os, re, sys
ROOT = os.environ.get("BRAIN_HOST_READ_ROOT", "/data/srv")
v = json.load(sys.stdin)
def fail(message):
 print(json.dumps({"error": message})); sys.exit(2)
op = v.get("op")
if op not in ("list", "read", "find"): fail("op must be list, read or find")
rel = v.get("path", "")
if not isinstance(rel, str) or len(rel) > 400 or "\x00" in rel: fail("path must be text of at most 400 characters")
rel = rel.strip("/")
if any(part in ("..",) for part in rel.split("/")): fail("path must not contain ..")
DENY_NAMES = [".env", ".env.*", "*.env", ".git", ".ssh", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "id_ecdsa*", "authorized_keys", "known_hosts",
 "*.db", "*.db-*", "*.sqlite", "*.sqlite3", "*.sqlite-*", "*.tar", "*.tar.gz", "*.tgz", "*.zip", "*.gz", "*.bak*", "credentials*", "secrets*", "shadow", ".htpasswd", ".netrc", ".npmrc", ".pypirc"]
DENY_DIRS = ["backups", "node_modules", "__pycache__", "lost+found"]
def denied(name):
 low = name.lower()
 return any(fnmatch.fnmatch(low, pattern) for pattern in DENY_NAMES) or low in DENY_DIRS
def clean_parts(path):
 return [p for p in path.split("/") if p]
base = os.path.realpath(ROOT)
target = os.path.realpath(os.path.join(base, rel)) if rel else base
if target != base and not target.startswith(base + os.sep): fail("that path is outside the readable area")
inside = clean_parts(os.path.relpath(target, base)) if target != base else []
if any(denied(p) for p in inside): fail("that file or folder is not readable through this tool (secrets, databases and backups are kept out)")
if not os.path.exists(target): fail("no such file or folder")
SECRET = re.compile(r"(?i)^(\s*[\w.\"-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential)[\w.\"-]*\s*[:=]\s*)(\S.*)$")
def redact(text):
 return "\n".join(SECRET.sub(lambda m: m.group(1) + "[redacted]", line) for line in text.split("\n"))
hidden = 0
out = {"op": op, "path": "/" + "/".join(inside), "hidden": 0, "truncated": False}
if op == "list":
 if not os.path.isdir(target): fail("list needs a folder")
 entries = []
 for name in sorted(os.listdir(target)):
  if denied(name): hidden += 1; continue
  full = os.path.join(target, name)
  try: st = os.lstat(full)
  except OSError: continue
  real = os.path.realpath(full)
  if os.path.islink(full) and not (real == base or real.startswith(base + os.sep)): hidden += 1; continue
  entries.append({"name": name, "type": "dir" if os.path.isdir(full) else "file", "bytes": st.st_size, "modified": int(st.st_mtime)})
 out["entries"] = entries[:200]; out["truncated"] = len(entries) > 200
elif op == "read":
 if not os.path.isfile(target): fail("read needs a file")
 limit = v.get("maxBytes", 16000)
 if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 65536: limit = 16000
 with open(target, "rb") as handle: raw = handle.read(limit + 1)
 if b"\x00" in raw[:4096]: fail("binary files are not readable through this tool")
 out["truncated"] = len(raw) > limit
 out["text"] = redact(raw[:limit].decode("utf-8", "replace"))
else:
 if not os.path.isdir(target): fail("find needs a folder")
 pattern = v.get("pattern", "*")
 if not isinstance(pattern, str) or not pattern or len(pattern) > 100: fail("pattern must be 1 to 100 characters")
 matches = []
 for dirpath, dirnames, filenames in os.walk(target):
  depth = len(clean_parts(os.path.relpath(dirpath, target))) if dirpath != target else 0
  keep = []
  for d in sorted(dirnames):
   if denied(d): hidden += 1
   elif depth < 4 and not os.path.islink(os.path.join(dirpath, d)): keep.append(d)
  dirnames[:] = keep
  for f in sorted(filenames):
   if denied(f): hidden += 1; continue
   if fnmatch.fnmatch(f.lower(), pattern.lower()): matches.append("/" + "/".join(clean_parts(os.path.relpath(os.path.join(dirpath, f), base))))
  if len(matches) > 100: break
 out["matches"] = matches[:100]; out["truncated"] = len(matches) > 100
out["hidden"] = hidden
print(json.dumps(out))
'
