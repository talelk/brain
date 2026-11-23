#!/usr/bin/env bash
set -euo pipefail
# chart.make: a CSV or JSON file of /work or /out becomes a chart, saved as PNG and SVG in /out.
#   stdin:  {"data": "/work/x.csv", "type": "bar|barh|line|pie|scatter", "name": "charts/sales",
#            "title": "...", "x": "column", "y": ["column", ...], "xlabel": "...", "ylabel": "..."}
#   stdout: {"png", "svg", "rows", "series"}
# JSON data is a list of objects. x defaults to the first column and y to the numeric other columns.
# matplotlib draws it; Arabic labels are shaped and reordered when arabic-reshaper and python-bidi
# are present (the sandbox image has them, with Noto fonts). CHART_MAKE_WORK and CHART_MAKE_OUT are
# for test.sh only: they replace /work and /out.

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
work = os.path.realpath(os.environ.get("CHART_MAKE_WORK", "/work"))
out = os.path.realpath(os.environ.get("CHART_MAKE_OUT", "/out"))
data, kind, name = v.get("data"), v.get("type", "bar"), v.get("name")
if not isinstance(data, str) or not data or "\x00" in data:
    fail("data must be text")
if kind not in ("bar", "barh", "line", "pie", "scatter"):
    fail("type must be bar, barh, line, pie or scatter")
real = os.path.realpath(data)
if not any((real + "/").startswith(r + "/") for r in (work, out)):
    fail("the data file must be under /work or /out")
if not os.path.isfile(real):
    fail("no such file")
if os.path.getsize(real) > 5_000_000:
    fail("the data file is larger than 5 MB")
if name is None:
    name = os.path.splitext(os.path.basename(real))[0]
if not isinstance(name, str) or not name or "\x00" in name or name.startswith("/") or ".." in name.split("/") or len(name) > 200:
    fail("name must be a relative path inside /out, without ..")
name = re.sub(r"\.(png|svg)$", "", name, flags=re.I)
for key in ("title", "xlabel", "ylabel", "x"):
    if v.get(key) is not None and (not isinstance(v[key], str) or len(v[key]) > 300):
        fail(key + " must be text of at most 300 characters")
ys = v.get("y")
if ys is not None and (not isinstance(ys, list) or not ys or len(ys) > 12 or not all(isinstance(c, str) for c in ys)):
    fail("y must be a list of 1 to 12 column names")

try:
    if real.lower().endswith(".json"):
        rows = json.load(open(real, encoding="utf-8"))
        if not isinstance(rows, list) or not rows or not all(isinstance(r, dict) for r in rows):
            fail("a JSON data file must be a non-empty list of objects")
    else:
        rows = list(csv.DictReader(open(real, encoding="utf-8-sig", newline="")))
        if not rows:
            fail("the data file has no rows")
except (ValueError, csv.Error) as e:
    fail("the data file cannot be read: " + str(e)[:200])
if len(rows) > 5000:
    fail("the data file has more than 5000 rows")
columns = list(rows[0].keys())

def num(x):
    try:
        return float(str(x).replace(",", "").strip())
    except ValueError:
        return None

xcol = v.get("x") or columns[0]
if xcol not in columns:
    fail("no column named " + xcol)
if ys is None:
    ys = [c for c in columns if c != xcol and all(num(r.get(c)) is not None for r in rows)]
if not ys:
    fail("no numeric column to draw")
for c in ys:
    if c not in columns:
        fail("no column named " + c)
    if any(num(r.get(c)) is None for r in rows):
        fail("column " + c + " is not numeric")

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except ImportError:
    fail("matplotlib is not installed in the tool sandbox")
try:
    import arabic_reshaper
    from bidi.algorithm import get_display
except ImportError:
    arabic_reshaper = None

def shape(s):
    s = "" if s is None else str(s)
    if arabic_reshaper is not None and re.search(r"[֐-ࣿ]", s):
        return get_display(arabic_reshaper.reshape(s))
    return s

plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["font.sans-serif"] = ["Noto Sans", "Noto Naskh Arabic", "Noto Sans Arabic", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False
plt.rcParams["svg.fonttype"] = "path"
plt.rcParams["axes.spines.top"] = False
plt.rcParams["axes.spines.right"] = False

labels = [shape(r.get(xcol)) for r in rows]
fig, ax = plt.subplots(figsize=(8, 4.8), dpi=150)
n = len(ys)
if kind == "pie":
    ax.pie([num(r[ys[0]]) for r in rows], labels=labels, autopct="%1.0f%%", startangle=90)
    ax.axis("equal")
elif kind == "scatter":
    xs = [num(r.get(xcol)) for r in rows]
    if any(x is None for x in xs):
        fail("a scatter chart needs a numeric x column")
    for c in ys:
        ax.scatter(xs, [num(r[c]) for r in rows], label=shape(c))
elif kind == "line":
    for c in ys:
        ax.plot(range(len(rows)), [num(r[c]) for r in rows], marker="o", label=shape(c))
    ax.set_xticks(range(len(rows)))
    ax.set_xticklabels(labels, rotation=30 if len(rows) > 6 else 0, ha="right" if len(rows) > 6 else "center")
else:
    width = 0.8 / n
    for i, c in enumerate(ys):
        pos = [j + (i - (n - 1) / 2) * width for j in range(len(rows))]
        vals = [num(r[c]) for r in rows]
        (ax.barh if kind == "barh" else ax.bar)(pos, vals, width, label=shape(c))
    ticks = list(range(len(rows)))
    if kind == "barh":
        ax.set_yticks(ticks)
        ax.set_yticklabels(labels)
    else:
        ax.set_xticks(ticks)
        ax.set_xticklabels(labels, rotation=30 if len(rows) > 6 else 0, ha="right" if len(rows) > 6 else "center")
if kind != "pie":
    ax.set_xlabel(shape(v.get("xlabel", xcol if kind != "barh" else "")))
    ax.set_ylabel(shape(v.get("ylabel", "" if n > 1 else ys[0])))
    if n > 1:
        ax.legend(frameon=False)
    ax.grid(axis="x" if kind == "barh" else "y", alpha=0.3)
if v.get("title"):
    ax.set_title(shape(v["title"]))
fig.tight_layout()

base = os.path.join(out, name)
os.makedirs(os.path.dirname(base), exist_ok=True)
if not (os.path.realpath(os.path.dirname(base)) + "/").startswith(out + "/"):
    fail("name must stay inside /out")
fig.savefig(base + ".png")
fig.savefig(base + ".svg")
print(json.dumps({"png": "/out/" + name + ".png", "svg": "/out/" + name + ".svg", "rows": len(rows), "series": ys}))
'
