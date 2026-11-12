#!/usr/bin/env python3
"""Provision the "SRE for the demos server" Brain workspace on the live Governor.

Idempotent: re-running reuses the workspace, skips documents whose title already exists and reuses the mission.
Runs on the demo host (talks to the Governor on 127.0.0.1:3100). Sign-in comes from BRAIN_ADMIN_EMAIL and
BRAIN_ADMIN_PASSWORD in the environment (see scripts/provision-sre-demos.sh); nothing is stored here.
Documents are read from scripts/demo/sre-demos/*.md, piped in as JSON on stdin by the wrapper.
"""
import base64, json, os, sys, urllib.error, urllib.request, uuid

BASE = "http://127.0.0.1:3100"
WS = "ws-sre-demos"
MISSION_TITLE = "Keep the demos server healthy"
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


files = json.load(sys.stdin)  # {"inventory.md": "<text>", ...}
st, res = api("POST", "/api/auth/sign-in/email", {"email": os.environ["BRAIN_ADMIN_EMAIL"], "password": os.environ["BRAIN_ADMIN_PASSWORD"]})
if st >= 400:
    raise SystemExit(f"login failed {st}")
TOKEN = res["token"]

st, res = api("POST", "/v1/setup/workspace", {"workspaceId": WS, "slug": "sre-demos",
    "description": "Site reliability for the demos server (/srv/demos): inventory, monitoring, runbooks, weekly health review.",
    "tags": ["sre", "demos-server", "operations"]})
print("workspace:", "created" if st == 201 else f"present ({st})")

have = {d.get("title") for d in query("documents.list", limit=100).get("items", [])}
for title, name in DOCS.items():
    if title in have:
        print("document kept:", title)
        continue
    r = cmd("document.upload", {"title": title, "fileName": name, "mediaType": "text/markdown",
                                "bytesBase64": base64.b64encode(files[name].encode()).decode()})
    print("document uploaded:", title, r.get("resourceId"))

found = [m for m in query("missions.list", limit=50).get("items", []) if m.get("title") == MISSION_TITLE]
if found:
    mission = found[0]
    print("mission reused:", mission["missionId"])
else:
    mid = cmd("mission.create", {
        "title": MISSION_TITLE,
        "intent": "Keep the demos server and every demo on it available. Review the documented inventory, monitoring and runbook for gaps, and produce a weekly health report with the most useful fixes. Agents read and reason only: they never hold SSH access, and anything destructive needs the owner's yes.",
        "successCriteria": ["Inventory and monitoring documents have no known gaps", "The runbook marks every risky step", "A weekly health report names what is red and the three best fixes"]})["resourceId"]
    mission = query("missions.get", resourceId=mid)
    print("mission created:", mid)

if mission.get("activePlanVersionId"):
    print("plan already confirmed")
else:
    planId = cmd("plan.propose", {"missionId": mission["missionId"], "origin": "manual",
        "summary": "Review the demos server documentation for gaps, then write the weekly health report.", "tasks": TASKS})["resourceId"]
    version = query("missions.get", resourceId=mission["missionId"])["version"]
    cmd("plan.confirm", {"planVersionId": planId}, expectedVersion=version)
    print("plan confirmed:", planId)
print("done")
