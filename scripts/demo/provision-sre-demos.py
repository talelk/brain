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


files = json.load(sys.stdin)  # {"inventory.md": "<text>", ...}
st, res = api("POST", "/api/auth/sign-in/email", {"email": os.environ["BRAIN_ADMIN_EMAIL"], "password": os.environ["BRAIN_ADMIN_PASSWORD"]})
if st >= 400:
    raise SystemExit(f"login failed {st}")
TOKEN = res["token"]

st, res = api("POST", "/v1/setup/workspace", {"workspaceId": WS, "slug": "sre-demos",
    "description": "Site reliability for the demos server (/srv/demos): inventory, monitoring, runbooks, weekly health review.",
    "tags": ["sre", "demos-server", "operations"]})
print("workspace:", "created" if st == 201 else f"present ({st})")

# ADR 0022: this workspace works the host with sre-task, and a task is Done only with a successful host.read or host.exec call on record.
# (It stays self-hosted: a workspace with host tools cannot switch the hosted model on, ADR 0023.) Idempotent.
cmd("workspace.wayOfWorking.set", {"workflowId": "sre-task", "requiredTools": ["host.exec", "host.read"]})
print("way of working: sre-task, observed tools host.exec or host.read")

# ADR 0024: host tools (host.*) run only on the runner group set aside for this workspace, and a change (restart, reload) needs the owner's
# approval of each call. What an agent may ask to restart is the owner's choice: the allow-list is only set from BRAIN_SRE_RESTARTABLE
# (comma-separated container names) and stays empty, so every restart is refused, until the owner names some. Idempotent.
cmd("runnerGroup.set", {"groupId": "sre-host", "hostTools": True, "workspaceIds": [WS]})
restartable = [name.strip() for name in os.environ.get("BRAIN_SRE_RESTARTABLE", "").split(",") if name.strip()]
cmd("workspace.effects.set", {"containers": restartable} if restartable else {})
print("runner group sre-host: host tools for this workspace only; restartable containers:", restartable or "none (set BRAIN_SRE_RESTARTABLE)")

have = {d.get("title"): d for d in query("documents.list", limit=100).get("items", [])}
for title, name in DOCS.items():
    if title in have:
        # Re-running keeps documents as they are; BRAIN_PROVISION_REVISE=1 saves the file's current text as a new revision.
        if os.environ.get("BRAIN_PROVISION_REVISE") == "1":
            cmd("document.revise", {"documentId": have[title]["documentId"], "title": title, "fileName": name, "mediaType": "text/markdown",
                                    "bytesBase64": base64.b64encode(files[name].encode()).decode()}, expectedVersion=have[title]["version"])
            print("document revised:", title)
        else:
            print("document kept:", title)
        continue
    r = cmd("document.upload", {"title": title, "fileName": name, "mediaType": "text/markdown",
                                "bytesBase64": base64.b64encode(files[name].encode()).decode()})
    print("document uploaded:", title, r.get("resourceId"))

MISSIONS = [
    {"title": MISSION_TITLE,
     "intent": "Keep the demos server and every demo on it available. Review the documented inventory, monitoring and runbook for gaps, and produce a weekly health report with the most useful fixes. Agents read and reason only: they never hold SSH access, and anything destructive needs the owner's yes.",
     "criteria": ["Inventory and monitoring documents have no known gaps", "The runbook marks every risky step", "A weekly health report names what is red and the three best fixes"],
     "summary": "Review the demos server documentation for gaps, then write the weekly health report.", "tasks": TASKS},
    {"title": LIVE_TITLE,
     "intent": "Look at the real demos server with the read-only host tools (files under /srv and named diagnostics) and report what is wrong or drifting, with the tool call that shows each fact. The agent changes nothing: fixes are written as commands for a person to run.",
     "criteria": ["Every finding names the tool call that showed it", "Unhealthy containers, low disk or memory and failing sites are listed with a likely cause", "Each fix is a command with its risk and how to undo it"],
     "summary": "Check containers, resources and sites on the live demos server.", "tasks": LIVE_TASKS},
]
existing = {m.get("title"): m for m in query("missions.list", limit=50).get("items", [])}
for spec in MISSIONS:
    mission = existing.get(spec["title"])
    if mission:
        print("mission reused:", mission["missionId"])
    else:
        mid = cmd("mission.create", {"title": spec["title"], "intent": spec["intent"], "successCriteria": spec["criteria"]})["resourceId"]
        mission = query("missions.get", resourceId=mid)
        print("mission created:", mid)
    if mission.get("activePlanVersionId"):
        print("plan already confirmed")
        continue
    planId = cmd("plan.propose", {"missionId": mission["missionId"], "origin": "manual", "summary": spec["summary"], "tasks": spec["tasks"]})["resourceId"]
    version = query("missions.get", resourceId=mission["missionId"])["version"]
    cmd("plan.confirm", {"planVersionId": planId}, expectedVersion=version)
    print("plan confirmed:", planId)
print("done")
