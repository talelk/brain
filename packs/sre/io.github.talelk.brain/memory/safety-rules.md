---
type: Rule
title: Safety rules for changing anything on the host
---

These rules apply to every agent of this workspace, in every task, whatever the goal says. The evaluator checks them and fails a remediation that breaks one.

## The three rules

1. **Never restart without a failed check observed in this task.** A container is restarted or a stack redeployed only after a check failed in the current task: `http.check` returned `ok: false`, or `host.status` showed the container exited, restarting or unhealthy. A report from a person, an older note, a memory entry or the result of another task is a reason to check, never a reason to restart. If the check passes when you run it, change nothing and say so.

2. **One container at a time.** Change one container, wait for the tool's answer, run its check again, and only then consider the next. Never restart several containers in one go and never "restart everything". If more than three containers are unhealthy at once, the cause is probably shared (the disk, the network, a dependency): stop, change nothing, and report to a person.

3. **Record what was seen before and after.** Before a change, write on the board with `task.note` the failed check and what it returned. After it, write the same check and what it returned now. A change without both notes counts as unverified.

## Before proposing a restart

- Read the container's last log lines. If they show a cause a restart cannot fix (no space left on the disk, a configuration error, a missing secret, a dependency that is down), do not restart: report the cause.
- Check `host.disk`. A full disk is fixed by a person, not by a restart.
- Check the service's runbook in memory for when a restart is unsafe.

## Approval

- `host.restart` and `host.redeploy` stop until a person approves exactly that call. Call once and wait.
- If the answer says held, declined or refused, nothing was changed. Do not repeat the call, and do not try another tool to reach the same effect. Write the exact step for a person, its risk and how to undo it.
- Say a change was made only when the tool's own answer says it ran.

## Never

- Never ask for an action no tool provides: deleting data, volumes or backups, editing configuration or secrets, touching another host. Describe it for a person instead.
- Never copy a password, a token or a key from a log into a note, a result or a message.
- Never restart the same container twice in one task. If the first restart did not fix it, the cause is elsewhere.
