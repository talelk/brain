#!/usr/bin/env python3
"""Provision a Brain workspace to manage/evolve/support Keyrus CV Insights.

Idempotent: re-running reuses the existing workspace/mission/plan and skips
dispatches that already have a linked run.
"""
import json, subprocess, sys, time, urllib.error, urllib.request, uuid

BASE = "http://127.0.0.1:3100"
WS = "ws-cvinsights"
WSDB = f"/data/workspaces/{WS}.db"
ADMIN = {"email": "admin@brain.local", "password": "92hXhRoNn9luCYlcAQ"}
WF = {}  # workflow id -> document digest, read from the active config release after login (never pinned here: digests change with every release)
MISSION_TITLE = "Operate, evolve and support Keyrus CV Insights"
TOKEN = ""

TASKS = [
    {"id": "support-queue", "title": "Respond to CV Insights support requests",
     "criteria": ["Drafted response addresses the reported issue", "Response is independently validated"],
     "dependsOn": [], "workflowId": "support-draft"},
    {"id": "incident-triage", "title": "Investigate operational incidents (sync/dashboard)",
     "criteria": ["Root cause identified", "Remediation proposed with evidence"],
     "dependsOn": [], "workflowId": "operations-triage"},
    {"id": "health-check", "title": "Verify dashboard availability and data freshness",
     "criteria": ["Dashboard returns 200", "Last Teamtailor sync within 24h"],
     "dependsOn": []},
    {"id": "evolve-roadmap", "title": "Plan the next CV Insights improvements",
     "criteria": ["Roadmap covers M1 dedup, M3/M4 resume intel, geo coverage", "Plan is validated"],
     "dependsOn": [], "workflowId": "plan-guide"},
]


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("content-type", "application/json")
    if TOKEN:
        req.add_header("authorization", "Bearer " + TOKEN)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=25) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def cmd(commandType, payload, ws=WS, expectedVersion=None):
    cid = "prov-" + uuid.uuid4().hex[:16]
    body = {"contractVersion": "brain.command/v1", "commandId": cid, "commandType": commandType,
            "idempotencyKey": cid, "payload": payload}
    if ws:
        body["workspaceId"] = ws
    if expectedVersion is not None:
        body["expectedVersion"] = expectedVersion
    st, res = api("POST", "/v1/commands", body)
    if st >= 400:
        raise SystemExit(f"command {commandType} failed {st}: {res}")
    return res


def query(queryType, ws=WS, resourceId=None, limit=None):
    """ProductQuery replies are envelopes; the payload is under `snapshot`."""
    body = {"queryType": queryType}
    if ws:
        body["workspaceId"] = ws
    if resourceId:
        body["resourceId"] = resourceId
    if limit:
        body["limit"] = limit
    st, res = api("POST", "/v1/query", body)
    if st >= 400:
        raise SystemExit(f"query {queryType} failed {st}: {res}")
    return res.get("snapshot", res)


def sql(statement, *params):
    """Read-only query against the workspace database inside the governor container."""
    encoded = ",".join(json.dumps(p) for p in params)
    out = subprocess.run(
        ["docker", "compose", "exec", "-T", "governor", "node", "-e",
         f"const db=require('better-sqlite3')('{WSDB}',{{readonly:true}});"
         f"console.log(JSON.stringify(db.prepare({json.dumps(statement)}).all({encoded})))"],
        cwd="/srv/demos/brain", capture_output=True, text=True)
    for line in reversed(out.stdout.strip().splitlines()):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise SystemExit(f"workspace query failed: {out.stdout[-400:]}{out.stderr[-400:]}")


# 1. login
st, res = api("POST", "/api/auth/sign-in/email", ADMIN)
if st >= 400:
    raise SystemExit(f"login failed {st}: {res}")
TOKEN = res["token"]
print("login ok")
for entry in query("workflows.list").get("items", []):
    WF[entry["release"]["id"]] = entry["release"]["digest"]

# 2. workspace (201 first time, conflict afterwards is fine)
st, res = api("POST", "/v1/setup/workspace", {"workspaceId": WS, "slug": "cv-insights",
    "description": "Operate, evolve and support Keyrus CV Insights (cvinsights.mykeyrus.tn): Teamtailor->DuckDB warehouse, parquet read model, Rill dashboards.",
    "tags": ["cvinsights", "keyrus-veille", "talent-intel", "demo"]})
print(f"workspace: {'created' if st == 201 else 'already present'}")

# 3. mission
found = [o for o in query("missions.list", limit=50).get("items", []) if o.get("title") == MISSION_TITLE]
if found:
    mission = found[0]
    print("mission reused:", mission["missionId"], "v" + str(mission["version"]))
else:
    missionId = cmd("mission.create", {
        "title": MISSION_TITLE,
        "intent": "Keep cvinsights.mykeyrus.tn healthy and current, respond to user/support requests, and continuously evolve the Teamtailor->DuckDB warehouse and Rill dashboards (M1 dedup, M3/M4 resume intel, geo coverage, sync reliability).",
        "successCriteria": [
            "Dashboard is available and data is fresh (last sync < 24h)",
            "Support and incident requests get an independently validated response",
            "A maintained evolution roadmap exists with tracked work items"]})["resourceId"]
    mission = query("missions.get", resourceId=missionId)
    print("mission created:", missionId)

# 4. plan — confirm at most one revision
if mission.get("activePlanVersionId"):
    print("plan already confirmed:", mission["activePlanVersionId"])
else:
    pending = sql("SELECT id FROM plan_versions WHERE mission_id=? AND state='proposed' ORDER BY revision DESC LIMIT 1",
                  mission["missionId"])
    planId = pending[0]["id"] if pending else cmd("plan.propose", {
        "missionId": mission["missionId"], "origin": "manual",
        "summary": "Baseline operating plan for the CV Insights demo.", "tasks": TASKS})["resourceId"]
    print("plan:", "reused proposed" if pending else "proposed", planId)
    version = query("missions.get", resourceId=mission["missionId"])["version"]
    cmd("plan.confirm", {"planVersionId": planId}, expectedVersion=version)
    print("plan confirmed:", planId)

# 5. work items
items = query("workItems.list", limit=50).get("items", [])
by_task = {i["planTaskId"]: i for i in items}
print("work items:", [(i["planTaskId"], i["state"]) for i in sorted(items, key=lambda i: i["planTaskId"])])

# 6. dispatch the workflow-linked items (skip ones already linked to a run)
already = {e.get("workItemId") for e in sql("SELECT work_item_id AS workItemId FROM execution_links")}
dispatches = {}


def dispatch(task_id, wf_id, inp):
    item = by_task.get(task_id)
    if not item:
        print(f"  !! no work item for {task_id}")
        return
    if item["workItemId"] in already:
        print(f"  {task_id} already has a linked run")
        return
    if wf_id not in WF:
        print(f"  !! workflow {wf_id} is not in the active release")
        return
    r = cmd("workflow.dispatch", {"workflow": {"id": wf_id, "digest": WF[wf_id]},
                                  "input": inp, "workItemId": item["workItemId"]})
    dispatches[task_id] = r["resourceId"]
    print(f"  dispatched {task_id} -> {r['resourceId']}")


dispatch("support-queue", "support-draft", {
    "title": "CV Insights intake chart looks stale",
    "body": "Users report the intake chart hasn't updated since the last Teamtailor sync. How do we confirm the daily sync ran and refresh the parquet read model for cvinsights.mykeyrus.tn?"})
dispatch("incident-triage", "operations-triage", {
    "situation": "cvinsights.mykeyrus.tn returns a 500 on the tech-usage canvas and the parquet export under /srv/demos/cvinsights/data looks stale. Investigate the sync + export path and propose remediation."})
dispatch("evolve-roadmap", "plan-guide", {
    "title": "CV Insights evolution roadmap",
    "intent": "Plan the next improvements to Keyrus CV Insights: candidate dedup (M1), resume intel extraction (M3/M4 orgs/tenures/tech), and geo coverage beyond TN.",
    "successCriteria": ["Prioritized roadmap with owners", "Effort + risk noted per item"],
    "capabilities": "Teamtailor MCP connector, DuckDB star schema, parquet read model, Rill dashboards, daily watermark sync",
    "reused": "",
    "related": ""})

# 7. poll runs
print("polling runs...")
deadline = time.time() + 300
states = {}
while time.time() < deadline:
    rows = sql("SELECT id,state FROM workflow_runs")
    states = {r["id"]: r["state"] for r in rows}
    if all(s in ("succeeded", "failed", "partial", "cancelled") for s in states.values()) and states:
        break
    time.sleep(8)
print("run states:", json.dumps(states))
print("work items:", json.dumps([(i["planTaskId"], i["state"]) for i in query("workItems.list", limit=50).get("items", [])]))
