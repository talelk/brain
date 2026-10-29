# Operate runs and approvals

## Dispatch

From the Web UI: Work → Workflows (or Agents) → select a workflow → dispatch with the
schema-validated input form. From the CLI:

```bash
rtk pnpm exec tsx apps/cli/src/main.ts workflow run operations-triage \
  --workspace operations --input '{"situation":"Error rates rose after a deployment."}'
```

Input validation happens before the command is durably accepted; a rejected dispatch
changes no state.

## Watch a run

Open Runs → the run detail page. Summary shows structured step outputs, Timeline shows
engine events (including governed tool calls), Evidence shows the independent verdict
and artifact links. Global search finds runs, approvals, agents, and workflows by id.
Live sessions support steering and stop.

## Approvals

Approval requests are exact, one-use decisions: the subject carries the precise effect,
target, and budget. Review the subject on Approvals → the review page and decide there;
the CLI refuses `approval.decision` because decisions require interactive human review.
Authors cannot approve their own effects. A submitted decision that was not observed
can be recovered from the review page. With required 2FA, the decision needs a current
native session plus TOTP; replaced or revoked sessions invalidate the evidence.

## Runners

Runs → Runners lists enrollment, group, capabilities, engine, and heartbeat. Drain or
quarantine from the runner detail page. `brain doctor --workspace <id>` checks release,
catalog, and placement. Runners that lose their lease stop making effects; their
attempt outcomes are recorded as unknown until reconciled.

## Reconcile uncertain effects

If an attempt's outcome is unknown (lost lease, crash, timeout), do not blindly
dispatch again. Reconcile the recorded target state first, then decide. The run detail
exposes the reconcile action; the evidence bundle names what the attempt claimed.

## Cancel

A run can be cancelled from the run detail page (`workflow.cancel`). Already-committed
effects are not undone by cancellation; they must be reconciled explicitly.
