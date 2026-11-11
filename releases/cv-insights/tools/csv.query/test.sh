#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, subprocess, sys
script = sys.argv[1]
broker = {"artifactId": "art-1", "digest": "sha256:" + "b" * 64, "csv": "city,pop\nOslo,700000\nBergen,285000\nTromso,77000\n"}
def run(sql, **extra):
 r = subprocess.run(["bash", script], input=json.dumps({"artifactId": "art-1", "sql": sql, "broker": broker, **extra}), capture_output=True, text=True)
 return r.returncode, json.loads(r.stdout)
code, out = run("SELECT city, pop FROM data WHERE pop > 100000 ORDER BY pop DESC")
assert code == 0 and out["rows"] == [["Oslo", 700000], ["Bergen", 285000]] and out["columns"] == ["city", "pop"], out
code, out = run("SELECT SUM(pop) AS total FROM data")
assert code == 0 and out["rows"] == [[1062000]], out
code, out = run("SELECT city FROM data", maxRows=2)
assert code == 0 and out["rowCount"] == 2 and out["truncated"] is True, out
for refused in (
 "DELETE FROM data", "DROP TABLE data", "INSERT INTO data VALUES ('x', 1)", "UPDATE data SET pop = 0",
 "ATTACH DATABASE '/tmp/x.db' AS other", "PRAGMA table_info(data)", "SELECT name FROM sqlite_master",
 "SELECT * FROM other", "SELECT load_extension('x')", "SELECT 1; SELECT 2", "CREATE TABLE t (a)",
):
 code, out = run(refused)
 assert code == 2 and "error" in out, (refused, out)
code, out = run("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n")
assert code == 2 and "error" in out, out
assert subprocess.run(["bash", script], input=json.dumps({"sql": "SELECT 1"}), capture_output=True, text=True).returncode == 2
print("csv.query: ok")
CHECKS
