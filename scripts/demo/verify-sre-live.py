#!/usr/bin/env python3
"""Live check of the SRE agent: start a small read-only mission on the demos server and report the tokens each attempt used.

Runs on the demo host. Sign-in is read on the server by scripts/verify-sre-live.sh; nothing is stored here.
Runs on the demo host (talks to the Governor on 127.0.0.1:3100). Sign-in comes from BRAIN_ADMIN_EMAIL and
BRAIN_ADMIN_PASSWORD in the environment (see scripts/provision-sre-demos.sh); nothing is stored here.
Documents are read from scripts/demo/sre-demos/*.md, piped in as JSON on stdin by the wrapper.
"""
import base64, json, os, sys, urllib.error, urllib.request, uuid

BASE = "http://127.0.0.1:3100"
WS = "ws-sre-demos"
MISSION_TITLE = "Keep the demos server healthy"
LIVE_TITLE = "Check the demos server live"
TOKEN = ""

DOCS = {  # title -> file
    "Demos server inventory": "inventory.md",
    "Monitoring and signals": "monitoring.md",
    "SRE runbook for the demos server": "runbook.md",
    "Access, safety and change rules": "access-and-safety.md",
}

TASKS = [
    {"id": "inventory-check", "title": "Check the inventory against what the owner reports running",
     "criteria": ["Every public name has an upstream port, folder and owner in the inventory", "Gaps or stale rows are listed with the source that shows them"],
     "dependsOn": [], "requiredTools": ["documents.read", "knowledge.search"]},
    {"id": "alerting-gaps", "title": "Find containers and sites with no health check or uptime check",
     "criteria": ["Containers without a health check are listed", "Sites missing from the uptime checks are listed", "Each gap has a proposed check"],
     "dependsOn": ["inventory-check"], "requiredTools": ["documents.read"]},
    {"id": "runbook-review", "title": "Review the runbook for missing or risky steps",
     "criteria": ["Each runbook section names its undo or its risk", "Destructive commands are flagged as needing the owner's yes"],
     "dependsOn": [], "requiredTools": ["documents.read"]},
    {"id": "weekly-report", "title": "Write the weekly server health report",
     "criteria": ["Report states what is red, what is trending badly, and the three most useful fixes", "Every fix has a command and a risk"],
     "dependsOn": ["inventory-check", "alerting-gaps", "runbook-review"], "requiredTools": ["documents.read"]},
]


LIVE_TASKS = [
    {"id": "containers-vs-inventory", "title": "Compare running containers with the inventory using the live server",
     "criteria": ["Every container that is not healthy is listed with its status and the tool call that showed it", "Containers or sites missing from the inventory, or in it but not running, are listed"],
     "dependsOn": [], "workflowId": "sre-task"},
    {"id": "resources-and-sites", "title": "Check disk, memory and the public demo sites on the live server",
     "criteria": ["Disk and memory use are stated with the tool call that showed them", "Each public demo site is reported up or down with its HTTP status"],
     "dependsOn": [], "workflowId": "sre-task"},
    {"id": "live-report", "title": "Write the live health report with fixes",
     "criteria": ["The report names what is red and the three most useful fixes", "Each fix is a command with its risk and how to undo it"],
     "dependsOn": ["containers-vs-inventory", "resources-and-sites"], "workflowId": "sre-task"},
]


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("content-type", "application/json")
    req.add_header("origin", "https://brain.mykeyrus.tn")
    if TOKEN:
        req.add_header("authorization", "Bearer " + TOKEN)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=30) as r:
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


import time
st, res = api("POST", "/api/auth/sign-in/email", {"email": os.environ["BRAIN_ADMIN_EMAIL"], "password": os.environ["BRAIN_ADMIN_PASSWORD"]})
if st >= 400:
    raise SystemExit(f"login failed {st}")
TOKEN = res["token"]
stamp = time.strftime("%H:%M")
TASKS = [
    {"id": "list", "title": "List the running containers",
     "criteria": ["The result gives how many containers run and lists them by name with status, citing the docker.ps call"],
     "dependsOn": [], "requiredTools": ["host.exec"]},
    {"id": "memory", "title": "Summarise memory use",
     "criteria": ["The result names the ten containers using the most memory, citing the docker.stats call", "Containers without a memory limit are named or none are stated"],
     "dependsOn": ["list"], "requiredTools": ["host.exec"]},
]
mid = cmd("mission.create", {"title": f"Live check of the SRE agent {stamp}", "intent": "Read-only: report how many containers run on the demos server, the ten using the most memory and any without a limit.",
                            "successCriteria": ["A short report with totals and the ten largest, each fact citing its tool call"], "autoStart": True})["resourceId"]
planId = cmd("plan.propose", {"missionId": mid, "origin": "manual", "summary": "List the containers, then summarise memory use.", "tasks": TASKS})["resourceId"]
version = query("missions.get", resourceId=mid)["version"]
cmd("plan.confirm", {"planVersionId": planId}, expectedVersion=version)
print("mission started:", mid, flush=True)
deadline = time.time() + 20 * 60
while time.time() < deadline:
    time.sleep(20)
    items = query("workItems.list", resourceId=mid, limit=20).get("items", [])
    print(stamp, [(i.get("title"), i.get("state"), i.get("tokensUsed"), i.get("failureClass")) for i in items], flush=True)
    if items and all(i.get("state") in ("done", "blocked", "abandoned") for i in items):
        break
print("finished")
