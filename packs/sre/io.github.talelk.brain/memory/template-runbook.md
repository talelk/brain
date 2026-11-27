---
type: Template
title: "Runbook template: one entry per service"
---

Copy this entry once for each service of the host, name the copy `runbook-<service>.md`, and replace everything in angle brackets. The agents find these entries with `memory.search` (they search for "runbook", "health address" and the service's name), so keep the headings as they are. Until a service has its own entry, the agents can see its container but do not know its health address, what it depends on, or which stack it belongs to.

## Service

- Name: `<service name, as people say it>`
- What it is for, and who uses it: `<one sentence>`
- Owner to ask: `<person or team>`
- How bad is an outage: `<blocks customers / blocks the team / can wait until morning>`

## Where it runs

- Container: `<exact name as host.status prints it>`
- Stack: `<stack name accepted by host.redeploy, or "none">`
- Health address: `<https://... the address http.check should call>`; healthy means `<status 200>`
- Depends on: `<other containers or outside services, each with its own health address>`

The host of every health address must be listed under `network` in the workspace's own copy of the `http.check` tool, or the check cannot reach it.

## Normal state

- `<what host.status shows when all is well: running, up for days>`
- `<usual response time of the health address>`
- `<log lines that look alarming but are normal>`

## Known failures

Repeat this block for each failure seen before.

- Symptom: `<what the check or the log shows>`
- Cause: `<what was behind it>`
- Fix: `<the action that worked>`
- Does a restart help: `<yes / no / only for a while>`

## Safe actions

- Restart: `<safe at any time / interrupts users for about N seconds / never during ...>`
- Redeploy: `<when it is appropriate, and what it interrupts>`
- Verify afterwards: `<the check that must pass, and how long to wait before running it>`

## Only a person does these

`<Actions the agents must never attempt and should hand to the owner with the evidence: restoring a backup, deleting data or volumes, changing configuration or secrets, anything on another host.>`
