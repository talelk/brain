#!/usr/bin/env bash
# cv.verify — independent verification of the agent's health report.
#
# The evaluator recomputes the same facts from the mounted read model and
# compares them against what the agent claimed. This is what makes the verdict
# meaningful: a report that is well-formed but fabricated fails here, and a
# report that correctly reports an unhealthy deployment PASSES. Health is the
# agent's finding, not the verifier's job.
# The program must not arrive on stdin: stdin carries the tool's JSON input.
# Passing it as -c keeps stdin free and needs no writable filesystem inside the
# read-only sandbox.
set -euo pipefail
program="$(cat <<'PY'
import json, os, glob, re, sys, time


def resolve_root():
    candidates = [os.environ.get("BRAIN_DATA_ROOT", ""), "/data/cvinsights-data", "/data/cvinsights"]
    for path in candidates:
        if path and os.path.isdir(path):
            return path
    return candidates[1]


ROOT = resolve_root()
AGE_TOLERANCE_HOURS = 6.0
REQUIRED_KEYS = {"summary", "findings", "nextActions", "observations"}


def actual():
    """Recompute the facts the agent was asked to report."""
    import duckdb
    con = duckdb.connect(":memory:")
    rows, newest = {}, 0
    for path in sorted(glob.glob(f"{ROOT}/**/*.parquet", recursive=True)):
        name = os.path.basename(path)[: -len(".parquet")]
        try:
            rows[name] = int(con.execute(f"SELECT COUNT(*) FROM read_parquet('{path}')").fetchone()[0])
            newest = max(newest, os.stat(path).st_mtime)
        except Exception:
            continue
    orphans = 0
    fact = os.path.join(ROOT, "warehouse_export", "fact_application.parquet")
    dim = os.path.join(ROOT, "warehouse_export", "dim_candidate.parquet")
    if os.path.exists(fact) and os.path.exists(dim):
        try:
            orphans = int(con.execute(
                f"SELECT COUNT(*) FROM read_parquet('{fact}') l "
                f"LEFT JOIN read_parquet('{dim}') r ON l.candidate_id=r.id "
                "WHERE l.candidate_id IS NOT NULL AND r.id IS NULL").fetchone()[0])
        except Exception:
            pass
    con.close()
    age = round((time.time() - newest) / 3600, 1) if newest else None
    return {"rows": rows, "empty": sorted(n for n, r in rows.items() if r == 0),
            "orphans": orphans, "ageHours": age, "tableCount": len(rows)}


def text_of(report):
    parts = [str(report.get("summary", ""))]
    for key in ("findings", "observations", "nextActions"):
        value = report.get(key)
        if isinstance(value, list):
            parts.extend(str(v) for v in value)
    return " ".join(parts)


def checks(report):
    out = []
    # 1. Shape: the report is the typed object the workflow promised.
    shape = isinstance(report, dict) and set(report) == REQUIRED_KEYS
    out.append({"id": "report-shape", "passed": shape,
                "detail": "exactly the four declared keys" if shape else f"keys were {sorted(report) if isinstance(report, dict) else type(report).__name__}"})

    facts = actual()
    body = text_of(report) if isinstance(report, dict) else ""
    lower = body.lower()

    # 2. Freshness: the age the agent stated must be the real age, and stale
    #    data must be called stale.
    stated = [float(m) for m in re.findall(r"(\d+(?:\.\d+)?)\s*(?:h\b|hours?\b)", body)]
    if facts["ageHours"] is None:
        out.append({"id": "freshness-claim", "passed": False, "detail": "no parquet exports to verify against"})
    else:
        real = facts["ageHours"]
        honest = any(abs(s - real) <= AGE_TOLERANCE_HOURS for s in stated)
        if real > 48:
            called_stale = "stale" in lower
            out.append({"id": "freshness-claim", "passed": honest and called_stale,
                        "detail": f"actual age {real}h; stated {stated[:3]}; used 'stale'={called_stale}"})
        else:
            out.append({"id": "freshness-claim", "passed": honest,
                        "detail": f"actual age {real}h; stated {stated[:3]}"})

    # 3. Row-count claims: any table the report calls empty must really be
    #    empty, and every genuinely empty table must be named.
    named_empty = {n for n in facts["empty"] if re.search(rf"\b{re.escape(n)}\b", lower)}
    wrong_empty = {n for n in named_empty if facts["rows"].get(n) != 0}
    missed = set(facts["empty"]) - named_empty
    out.append({"id": "empty-table-claims", "passed": not wrong_empty and not missed,
                "detail": (f"actual empty: {facts['empty'][:6]}; named: {sorted(named_empty)[:6]}; "
                           f"wrongly claimed: {sorted(wrong_empty)}; omitted: {sorted(missed)}")})

    # 4. Orphan claims must match the real join integrity. A report that says
    #    "no orphan keys were found" claims zero, not "mentioned orphans".
    if re.search(r"\bno\b[^.]{0,40}orphan|orphan\w*\s+(?:is|are|was|were)\s+(?:zero|none|0)", lower):
        claims_orphans = False
    else:
        claims_orphans = re.search(r"orphan", lower) is not None
    matches = claims_orphans == (facts["orphans"] > 0)
    out.append({"id": "orphan-claims", "passed": matches,
                "detail": f"actual orphans {facts['orphans']}; report claims orphans={claims_orphans}"})

    # 5. The report must carry actionable next steps, not just observations.
    actions = report.get("nextActions") if isinstance(report, dict) else None
    usable = isinstance(actions, list) and len(actions) >= 1 and all(isinstance(a, str) and len(a.strip()) > 8 for a in actions)
    out.append({"id": "actionable-next-actions", "passed": usable,
                "detail": f"{len(actions) if isinstance(actions, list) else 0} nextActions"})

    return {"passed": all(c["passed"] for c in out), "checks": out,
            "verifiedAgainst": {"tableCount": facts["tableCount"], "ageHours": facts["ageHours"], "orphans": facts["orphans"]}}


try:
    payload = json.load(sys.stdin)
except Exception as exc:
    print(json.dumps({"passed": False, "checks": [{"id": "report-shape", "passed": False, "detail": f"unreadable evaluator input: {type(exc).__name__}"}]}))
    raise SystemExit(0)

report = payload.get("report")
if isinstance(report, str):
    try:
        report = json.loads(report)
    except Exception:
        pass
try:
    print(json.dumps(checks(report if isinstance(report, dict) else {})))
except Exception as exc:
    print(json.dumps({"passed": False, "checks": [{"id": "verifier", "passed": False, "detail": f"{type(exc).__name__}: {exc}"}]}))
PY
)"
exec python3 -c "$program"
