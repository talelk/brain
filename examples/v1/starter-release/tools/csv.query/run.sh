#!/usr/bin/env bash
set -euo pipefail
# The broker supplies the CSV text of exactly one artifact of this workspace under "broker". The query runs against an
# in-memory SQLite database that holds only that table (named data); an authorizer lets it read that table and nothing else,
# so it cannot write, attach, run pragmas or read any other table or file.
exec python3 -c '
import csv, io, json, re, sqlite3, sys, time
v = json.load(sys.stdin)
b = v.get("broker")
def fail(message):
 print(json.dumps({"error": message})); sys.exit(2)
if not isinstance(b, dict) or not isinstance(b.get("csv"), str) or "artifactId" not in b or "digest" not in b: fail("the broker supplied no CSV artifact")
sql = v.get("sql")
if not isinstance(sql, str) or not sql.strip() or len(sql) > 2000: fail("sql must be one non-empty statement of at most 2000 characters")
max_rows = v.get("maxRows", 50)
if not isinstance(max_rows, int) or isinstance(max_rows, bool) or not 1 <= max_rows <= 200: max_rows = 50
rows = list(csv.reader(io.StringIO(b["csv"])))
if not rows or not rows[0]: fail("the artifact holds no CSV header")
header, seen = [], set()
for name in rows[0]:
 clean = re.sub(r"[^0-9A-Za-z_]", "_", name.strip()) or "col"
 if clean[0].isdigit(): clean = "c_" + clean
 base, n = clean, 2
 while clean.lower() in seen: clean, n = "%s_%d" % (base, n), n + 1
 seen.add(clean.lower()); header.append(clean)
body = [(r + [""] * len(header))[:len(header)] for r in rows[1:]]
def column_type(i):
 values = [r[i] for r in body if r[i] != ""]
 for kind, cast in (("INTEGER", int), ("REAL", float)):
  try:
   [cast(x) for x in values]; return kind
  except ValueError: pass
 return "TEXT"
types = [column_type(i) for i in range(len(header))]
conn = sqlite3.connect(":memory:")
conn.execute("CREATE TABLE data (%s)" % ", ".join("\"%s\" %s" % (h, t) for h, t in zip(header, types)))
conn.executemany("INSERT INTO data VALUES (%s)" % ", ".join("?" * len(header)), [[None if cell == "" else (int(cell) if t == "INTEGER" else float(cell) if t == "REAL" else cell) for cell, t in zip(r, types)] for r in body])
SELECT, READ, FUNCTION, RECURSIVE = 21, 20, 31, 33
def authorize(action, arg1, arg2, db_name, source):
 if action in (SELECT, FUNCTION, RECURSIVE): return sqlite3.SQLITE_OK
 if action == READ and arg1 == "data": return sqlite3.SQLITE_OK
 return sqlite3.SQLITE_DENY
conn.set_authorizer(authorize)
deadline = time.monotonic() + 5
conn.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 1000)
try:
 cursor = conn.execute(sql.strip().rstrip(";"))
 fetched = cursor.fetchmany(max_rows + 1)
except Exception as error:
 fail("query refused or failed: %s" % error)
def cell(value):
 if isinstance(value, (bytes, bytearray)): return "<%d bytes>" % len(value)
 return value[:500] if isinstance(value, str) else value
columns = [d[0] for d in cursor.description or []]
out_rows = [[cell(x) for x in row] for row in fetched[:max_rows]]
print(json.dumps({"artifactId": b["artifactId"], "digest": b["digest"], "columns": columns, "rows": out_rows, "rowCount": len(out_rows), "truncated": len(fetched) > max_rows}))
'
