#!/usr/bin/env bash
set -euo pipefail
# sheet.build: a CSV or JSON file of /work or /out becomes an XLSX workbook in /out.
#   stdin:  {"data": "/work/x.csv", "name": "tables/x.xlsx", "sheet": "Data"}
#   stdout: {"path", "rows", "columns"}
# JSON data is a list of objects (the keys of the first one are the columns) or an object of
# sheet name to such a list (one sheet each). Numbers are written as numbers; the header row is
# bold on a coloured fill, frozen, filtered, and the columns are sized to their content. A sheet
# of Arabic text is set right to left. openpyxl does the writing. SHEET_BUILD_WORK and
# SHEET_BUILD_OUT are for test.sh only: they replace /work and /out.

exec python3 -I -c '
import csv, json, os, re, sys

def fail(why):
    print(json.dumps({"error": why}))
    sys.exit(2)

try:
    v = json.load(sys.stdin)
except ValueError:
    fail("the input is not JSON")
if not isinstance(v, dict):
    fail("the input must be a JSON object")
work = os.path.realpath(os.environ.get("SHEET_BUILD_WORK", "/work"))
out = os.path.realpath(os.environ.get("SHEET_BUILD_OUT", "/out"))
data, name, sheet = v.get("data"), v.get("name"), v.get("sheet")
if not isinstance(data, str) or not data or "\x00" in data:
    fail("data must be text")
real = os.path.realpath(data)
if not any((real + "/").startswith(r + "/") for r in (work, out)):
    fail("the data file must be under /work or /out")
if not os.path.isfile(real):
    fail("no such file")
if os.path.getsize(real) > 10_000_000:
    fail("the data file is larger than 10 MB")
if name is None:
    name = os.path.splitext(os.path.basename(real))[0] + ".xlsx"
if not isinstance(name, str) or not name or "\x00" in name or name.startswith("/") or ".." in name.split("/") or len(name) > 200:
    fail("name must be a relative path inside /out, without ..")
if not name.lower().endswith(".xlsx"):
    fail("name must end with .xlsx")
if sheet is not None and (not isinstance(sheet, str) or not sheet.strip() or len(sheet) > 31 or re.search(r"[\[\]:*?/\\\\]", sheet)):
    fail("sheet must be a name of at most 31 characters without []:*?/ or backslash")

try:
    if real.lower().endswith(".json"):
        loaded = json.load(open(real, encoding="utf-8"))
        tables = loaded if isinstance(loaded, dict) else {sheet or "Data": loaded}
        for t, rows in tables.items():
            if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
                fail("a JSON data file must be a list of objects, or an object of such lists")
        tables = {t: ([list(r.keys()) for r in rows[:1]] + [[r.get(k) for k in rows[0]] for r in rows]) if rows else [] for t, rows in tables.items()}
    else:
        tables = {sheet or "Data": list(csv.reader(open(real, encoding="utf-8-sig", newline="")))}
except (ValueError, csv.Error) as e:
    fail("the data file cannot be read: " + str(e)[:200])
if not tables or any(len(rows) == 0 for rows in tables.values()):
    fail("the data file has no rows")
if sum(len(r) for r in tables.values()) > 100000:
    fail("the data file has more than 100000 rows")

try:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
except ImportError:
    fail("openpyxl is not installed in the tool sandbox")

def cell(x):
    if isinstance(x, (dict, list)):
        return json.dumps(x, ensure_ascii=False)
    if isinstance(x, str):
        s = x.strip()
        if re.fullmatch(r"-?\d+", s) and len(s) < 16 and not (len(s) > 1 and s.lstrip("-").startswith("0")):
            return int(s)
        if re.fullmatch(r"-?\d*\.\d+", s):
            return float(s)
        return x[:32000]
    return x

wb = Workbook()
wb.remove(wb.active)
rows_total, cols_total = 0, 0
for title, rows in tables.items():
    ws = wb.create_sheet(str(title)[:31] or "Data")
    width = max(len(r) for r in rows)
    for i, r in enumerate(rows):
        values = [cell(x) if i else ("" if x is None else str(x)) for x in r]
        ws.append(values + [None] * (width - len(values)))
    head = PatternFill("solid", fgColor="1F3A5F")
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = head
        c.alignment = Alignment(vertical="center", wrap_text=True)
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    for j in range(1, width + 1):
        longest = max(len(str(r[j - 1])) if j - 1 < len(r) and r[j - 1] is not None else 0 for r in rows)
        ws.column_dimensions[get_column_letter(j)].width = min(60, max(8, longest + 2))
    if any(re.search(r"[֐-ࣿ]", str(x)) for r in rows for x in r):
        ws.sheet_view.rightToLeft = True
    rows_total += len(rows) - 1
    cols_total = max(cols_total, width)

target = os.path.join(out, name)
os.makedirs(os.path.dirname(target), exist_ok=True)
if not (os.path.realpath(os.path.dirname(target)) + "/").startswith(out + "/"):
    fail("name must stay inside /out")
wb.save(target)
print(json.dumps({"path": "/out/" + name, "rows": rows_total, "columns": cols_total}))
'
