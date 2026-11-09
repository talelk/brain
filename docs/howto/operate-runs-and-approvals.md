# Operate runs and approvals

Last reviewed against commit 6fb59ae.

## Dispatch

From the Web UI: **Plays**, choose a play or single task, fill the validated input
form and confirm. Or start from **Missions → New mission**. From the CLI:

```bash
rtk pnpm exec tsx apps/cli/src/main.ts workflow run operations-triage \
  --workspace operations --input '{"situation":"Error rates rose after a deployment."}'
```

Input validation happens before the command is durably accepted; a rejected dispatch
changes no state.

## Watch a run

Open **Live** for running sessions and jobs, or the mission's Live tab. Open a session
(`/sessions/:id`) to read it, steer or stop it. Open the run inspector
(`/runs/:id`) for attempts, evidence and placement. **Logs** searches execution and
platform logs; **Outputs** holds the results.

## Approvals

Approvals are under **Missions** (`/approvals`). Each request is an exact, one-use
decision: the subject carries the precise effect, target and budget. Review it on the
approval page (`/approvals/:id`) and decide there; the CLI refuses
`approval.decision` because decisions need interactive human review. Authors cannot
approve their own effects. A submitted decision that was not observed can be recovered
from the review page. With required 2FA, the decision needs a current native session
plus TOTP; replaced or revoked sessions invalidate the evidence.

## Runners

**Live → Runners** (administrators, `/runners`) lists enrollment, group, capabilities,
engine and heartbeat. Drain or quarantine from the runner detail page.
`brain doctor --workspace <id>` checks release, catalog and placement. Runners that
lose their lease stop making effects; their attempt outcomes are recorded as unknown
until reconciled.

## Reconcile uncertain effects

If an attempt's outcome is unknown (lost lease, crash, timeout), do not dispatch again
blindly. Reconcile the recorded target state first, then decide. The run inspector
exposes the reconcile action; the evidence names what the attempt claimed.

## Cancel

Cancel from the run inspector (`workflow.cancel`). Already-committed effects are not
undone; reconcile them explicitly.
