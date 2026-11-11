# Operations starter release

Compile this directory with `brain config compile`, inspect the returned digest, then activate it explicitly.

The agents use Pi and have no child agents. Operations Assistant may call only the pinned read-only `operations.context` demonstration tool; Support Analyst has no tools. All outputs are checked by a separate deterministic evaluator attempt restricted to the Claude-provisioned `evaluators` runner group. L1 proves a separate attempt; it does not attest a separate physical host or model quality.

- `agent-smoke`: input `{"message":"BRAIN_OK"}`; exact expected model output is the JSON string `"BRAIN_OK"`.
- `runner-topology-smoke`: the same input and output contract, with explicit Pi-author and Claude-evaluator placement for startup verification.
- `operations-triage`: input `{"situation":"Describe an incident or operational situation"}`.
- `general-task`: input `{"situation":"Task title\nAcceptance criteria:\n1. ..."}` (the shape auto-start sends; optional `Upstream results:` lines carry earlier tasks' conclusions). The Governor also puts a context pack in front of every agent step that serves a mission task (brief, decisions, dependency handoffs, messages; the manifest is stored with the run and shown on the run page). The `task-worker` agent may call the read-only governed tools `documents.read`, `web.fetch` (GET, hosts from the Tool document) and `csv.query`, and returns `{summary, deliverable (Markdown), criteria[{criterion, met, evidence}], assumptions}`. The `task-validator` evaluator (`task.validate`) re-reads the criteria from the situation and checks `structure`, `safety`, `deliverable` (substantial, not a request for clarification) and `criteria-met` (every criterion answered once, claimed met with evidence; rows are matched by normalised wording and a reworded row is accepted at its criterion's position). Like the other validators it is deterministic: it proves the report answers every criterion, not that the answers are right. Auto-start prefers it for tasks without a workflow.
- `support-draft`: input `{"title":"Ticket title","body":"Ticket body"}`; output remains a draft.

The validator checks structure and forbidden side-effect fields. It does not establish semantic accuracy or prove that advice is safe to execute. No workflow publishes or executes the proposed actions.

The daily task catalog contains two tasks. `agent-smoke` is an installation diagnostic,
and `task-guide` is the internal read-only conversational helper. The guide has no tools;
it prepares candidate inputs and questions, independently validates its output, and never
starts the proposed task. The Governor validates proposals against the authorized active
catalog and requires explicit human confirmation. Presentation metadata supplies task
names, examples and system visibility. The guide has a 16384-token budget; the ordinary
starter agents retain 8192-token budgets.
