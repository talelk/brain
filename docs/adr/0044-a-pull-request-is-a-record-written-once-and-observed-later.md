# 44. A pull request is a record written once, and its state is observed later

Status: accepted, 2026-11-15.

An approved `git.open-pr` call clones, branches, pushes and opens the request, and the address only went back to the proposing task as the effect's result. Nothing kept it, so a person could not find or follow the request. Runs and evidence are referenced by digest and never edited (ADR 0018, ADR 0022); a pull request's state changes at the provider, so a single stored status would either go stale or be rewritten.

## Decision
1. **One record per approval.** When the Governor opens the request it writes `pull_requests` from the provider's own answer (address, number, branch, base, commit) plus the provider and repository copied from the connection, and the work item, mission and run the proposing task served (through the run's execution link; empty for a run that serves none). `approval_id` is unique, so a retry or restart writes nothing twice. Triggers refuse any update or delete of the row.
2. **Written from the Governor's answer, not the receipt.** The receipt the runner uploads is bytes the runner relayed. The Governor already holds what the provider answered, so the record is written at that point, before the runner reports the outcome. A request the provider opened is therefore recorded even if the runner dies before it can settle the call.
3. **State is a later row.** `pull_request_states` gains a row when the request is opened (state open, source "opened") and one for every manual refresh (source "refresh", by whom). The newest row is the current state; the first row is the state at the time it was opened and never changes. A refresh asks the provider through the connection the request was opened over, with a read-only call, and refuses in plain words when that connection is gone or no longer verifies. A change of state is also said in the approval's history.
4. **Refresh is a person's command** (`pullRequest.refresh`, human only). It uses the connection's credentials, so no session can. The `git.open-pr` input, its approval and the result fed to the resumed attempt are unchanged: an agent may do nothing more than before.
5. **No webhook.** The state moves when someone refreshes it. Provider webhooks (#138) can later add the same observation rows without changing the record.
