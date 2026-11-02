#!/usr/bin/env bash
# cv.warehouse — read-only facts from the CV Insights read model.
# The parquet exports under /data/<mount> are exactly what the dashboard
# serves, so a run that reads them cannot invent freshness or row counts.
# Output is deliberately compact: the agent's token budget is a pinned limit,
# and a 90-entry file dump would spend it before the agent could reason.
set -euo pipefail
exec python3 - <<'PY'
import json, os, glob, time
from datetime import datetime, timezone


def resolve_root():
    """The launcher mounts operator-declared data at /data/<name>; the name is
    operator configuration, so pick the first candidate that exists instead of
    hardcoding one spelling that silently breaks on a rename."""
    candidates = [os.environ.get("BRAIN_DATA_ROOT", ""), "/data/cvinsights-data", "/data/cvinsights"]
    for path in candidates:
        if path and os.path.isdir(path):
            return path
    return candidates[1]


ROOT = resolve_root()
TOP_TABLES = 8


def facts():
    out = {"tableCount": 0, "rows": {}, "observations": [], "limitations": []}
    if not os.path.isdir(ROOT):
        out["observations"].append(f"read model is not mounted at {ROOT}")
        return out

    import duckdb
    con = duckdb.connect(":memory:")
    paths, newest, oldest = {}, 0, 0
    for path in sorted(glob.glob(f"{ROOT}/**/*.parquet", recursive=True)):
        name = os.path.basename(path)[: -len(".parquet")]
        paths[name] = path
        mtime = os.stat(path).st_mtime
        newest, oldest = max(newest, mtime), min(oldest, mtime) if oldest else mtime

    for name, path in sorted(paths.items()):
        try:
            out["rows"][name] = int(con.execute(f"SELECT COUNT(*) FROM read_parquet('{path}')").fetchone()[0])
        except Exception as exc:  # an unreadable export is a finding, not a crash
            out["observations"].append(f"{name}: unreadable ({type(exc).__name__})")
    con.close()

    out["tableCount"] = len(out["rows"])
    empty = sorted(n for n, r in out["rows"].items() if r == 0)
    if empty:
        out["observations"].append("empty tables: " + ", ".join(empty[:12]))
    if newest:
        age = round((time.time() - newest) / 3600, 1)
        out["newestAgeHours"] = age
        out["newestExportAt"] = datetime.fromtimestamp(newest, timezone.utc).isoformat()
        out["observations"].append(f"newest export is {age}h old")
        if age > 48:
            out["observations"].append("exports are older than two sync cycles; the dashboard is serving stale data")
    else:
        out["limitations"].append("no parquet files found under the mounted read model")
    if out["tableCount"] == 0:
        out["limitations"].append("the mounted path contains no parquet exports")
    # Largest tables are the ones a reviewer actually wants row counts for.
    out["largest"] = [{"table": n, "rows": r} for n, r in sorted(out["rows"].items(), key=lambda kv: -kv[1])[:TOP_TABLES]]
    return out


try:
    print(json.dumps(facts()))
except Exception as exc:
    print(json.dumps({"observations": [f"warehouse inspection failed: {type(exc).__name__}: {exc}"],
                      "limitations": ["tool could not complete"]}))
PY
