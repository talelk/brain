#!/usr/bin/env bash
# cv.integrity — real consistency checks on the CV Insights read model.
# These are the checks a reviewer actually cares about: required tables exist,
# they are non-empty, and the join keys the dashboards rely on resolve.
set -euo pipefail
exec python3 - <<'PY'
import json, os, glob
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
REQUIRED = ["dim_candidate", "dim_job", "dim_org", "dim_tech", "fact_application"]
JOIN_CHECKS = [
    ("fact_application", "candidate_id", "dim_candidate", "id"),
    ("fact_application", "job_id", "dim_job", "id"),
]


def tables():
    found = {}
    for path in sorted(glob.glob(f"{ROOT}/**/*.parquet", recursive=True)):
        name = os.path.basename(path)[: -len(".parquet")]
        found[name] = path
    return found


def checks():
    if not os.path.isdir(ROOT):
        return {"passed": False, "checks": [{"id": "mounted", "passed": False}], "detail": "read model not mounted"}
    found = tables()
    out = []
    missing = [t for t in REQUIRED if t not in found]
    out.append({"id": "required-tables", "passed": not missing, "detail": f"missing: {missing}" if missing else "all present"})

    empty = []
    for name, path in found.items():
        try:
            import duckdb
            con = duckdb.connect(":memory:")
            n = int(con.execute(f"SELECT COUNT(*) FROM read_parquet('{path}')").fetchone()[0])
            con.close()
            if n == 0:
                empty.append(name)
        except Exception:
            continue
    out.append({"id": "non-empty", "passed": not empty, "detail": f"empty: {empty}" if empty else "no empty tables"})

    try:
        import duckdb
        con = duckdb.connect(":memory:")
        orphans = []
        for left, lcol, right, rcol in JOIN_CHECKS:
            if left not in found or right not in found:
                continue
            q = (f"SELECT COUNT(*) FROM read_parquet('{found[left]}') l "
                 f"LEFT JOIN read_parquet('{found[right]}') r ON l.{lcol}=r.{rcol} "
                 f"WHERE l.{lcol} IS NOT NULL AND r.{rcol} IS NULL")
            n = int(con.execute(q).fetchone()[0])
            if n > 0:
                orphans.append(f"{left}.{lcol}->{right}.{rcol}:{n}")
        con.close()
        out.append({"id": "join-integrity", "passed": not orphans, "detail": f"orphans {orphans}" if orphans else "keys resolve"})
    except Exception as exc:
        out.append({"id": "join-integrity", "passed": False, "detail": f"could not evaluate: {type(exc).__name__}"})

    newest = max((os.stat(p).st_mtime for p in found.values()), default=0)
    if newest:
        age = (datetime.now(timezone.utc) - datetime.fromtimestamp(newest, timezone.utc)).total_seconds() / 3600
        out.append({"id": "freshness", "passed": age <= 48, "detail": f"newest export {round(age, 1)}h old"})

    return {"passed": all(c["passed"] for c in out), "checks": out, "tableCount": len(found)}


try:
    print(json.dumps(checks()))
except Exception as exc:
    print(json.dumps({"passed": False, "checks": [{"id": "tool", "passed": False}], "detail": f"{type(exc).__name__}: {exc}"}))
PY
