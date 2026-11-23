#!/usr/bin/env bash
set -euo pipefail
# Proves run.sh on temporary folders: no network and nothing outside them. It needs matplotlib
# (the sandbox image has it); where it is absent the drawing checks are skipped with a message and
# only the refusals are checked.

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/work" "$tmp/out"
printf 'month,sales,costs\nJan,10,4\nFeb,14,5\nمارس,9,6\n' >"$tmp/work/a.csv"
printf '[{"k":"a","v":3},{"k":"b","v":5}]' >"$tmp/work/b.json"

have=0
python3 -c 'import matplotlib' 2>/dev/null && have=1
[ "$have" = 1 ] || echo "chart.make: matplotlib is not installed here, drawing checks skipped"

CHART_MAKE_WORK="$tmp/work" CHART_MAKE_OUT="$tmp/out" HAVE_MPL="$have" python3 - "$here/run.sh" "$tmp" <<'CHECKS'
import json, os, subprocess, sys

script, tmp = sys.argv[1], sys.argv[2]

def run(payload):
    r = subprocess.run(["bash", script], input=payload if isinstance(payload, str) else json.dumps(payload), capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout)

if os.environ["HAVE_MPL"] == "1":
    code, out = run({"data": tmp + "/work/a.csv", "type": "bar", "name": "charts/sales", "title": "المبيعات"})
    assert code == 0 and out["series"] == ["sales", "costs"] and out["rows"] == 3, out
    assert open(tmp + "/out/charts/sales.png", "rb").read(4) == b"\x89PNG"
    assert b"<svg" in open(tmp + "/out/charts/sales.svg", "rb").read(2000)
    for kind in ("line", "barh", "pie", "scatter"):
        payload = {"data": tmp + "/work/b.json", "type": kind, "name": kind}
        if kind == "scatter":
            payload = {"data": tmp + "/work/a.csv", "type": kind, "x": "sales", "y": ["costs"], "name": kind}
        code, out = run(payload)
        assert code == 0 and os.path.getsize(tmp + "/out/" + kind + ".png") > 0, (kind, out)

for payload in [
    {"data": tmp + "/work/a.csv", "type": "radar"},
    {"data": tmp + "/work/a.csv", "name": "../x"},
    {"data": tmp + "/work/a.csv", "name": "/abs"},
    {"data": tmp + "/work/a.csv", "y": ["month"]},
    {"data": tmp + "/work/a.csv", "y": ["nope"]},
    {"data": "/etc/passwd"},
    {"data": tmp + "/work/none.csv"},
    {},
    "not json",
]:
    code, out = run(payload)
    assert code == 2 and "error" in out, (payload, out)
print("chart.make: ok")
CHECKS
