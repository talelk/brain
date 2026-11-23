#!/usr/bin/env bash
set -euo pipefail
# Proves run.sh on temporary folders: no network and nothing outside them. It needs openpyxl (the
# sandbox image has it); where it is absent the check is skipped with a message.

here="$(cd "$(dirname "$0")" && pwd)"
if ! python3 -c 'import openpyxl' 2>/dev/null; then echo "sheet.build: skipped (openpyxl is not installed here)"; exit 0; fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/work" "$tmp/out"
printf 'item,qty,price\nbolt,12,0.5\nنص,3,007\n' >"$tmp/work/a.csv"
printf '{"One":[{"a":1,"b":"x"}],"Two":[{"c":2}]}' >"$tmp/work/b.json"

SHEET_BUILD_WORK="$tmp/work" SHEET_BUILD_OUT="$tmp/out" python3 - "$here/run.sh" "$tmp" <<'CHECKS'
import json, subprocess, sys
from openpyxl import load_workbook

script, tmp = sys.argv[1], sys.argv[2]

def run(payload):
    r = subprocess.run(["bash", script], input=payload if isinstance(payload, str) else json.dumps(payload), capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout)

code, out = run({"data": tmp + "/work/a.csv", "name": "t/a.xlsx", "sheet": "Stock"})
assert code == 0 and out == {"path": "/out/t/a.xlsx", "rows": 2, "columns": 3}, out
ws = load_workbook(tmp + "/out/t/a.xlsx")["Stock"]
assert ws["A1"].font.bold and ws.freeze_panes == "A2", "header style"
assert ws["B2"].value == 12 and ws["C2"].value == 0.5 and ws["C3"].value == "007" and ws["A3"].value == "نص"
assert ws.sheet_view.rightToLeft is True

code, out = run({"data": tmp + "/work/b.json"})
assert code == 0 and out["path"] == "/out/b.xlsx", out
assert load_workbook(tmp + "/out/b.xlsx").sheetnames == ["One", "Two"]

for payload in [
    {"data": tmp + "/work/a.csv", "name": "../x.xlsx"},
    {"data": tmp + "/work/a.csv", "name": "x.csv"},
    {"data": tmp + "/work/a.csv", "sheet": "a/b"},
    {"data": "/etc/passwd"},
    {"data": tmp + "/work/none.csv"},
    {},
    "not json",
]:
    code, out = run(payload)
    assert code == 2 and "error" in out, (payload, out)
print("sheet.build: ok")
CHECKS
