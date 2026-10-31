# Operations starter release

Compile this directory with `brain config compile`, inspect the returned digest, then activate it explicitly.

The agents use Pi and have no child agents. Operations Assistant may call only the pinned read-only `operations.context` demonstration tool; Support Analyst has no tools. All outputs are checked by a separate deterministic evaluator attempt restricted to the Claude-provisioned `evaluators` runner group. L1 proves a separate attempt; it does not attest a separate physical host or model quality.

- `agent-smoke`: input `{"message":"BRAIN_OK"}`; exact expected model output is the JSON string `"BRAIN_OK"`.
- `runner-topology-smoke`: the same input and output contract, with explicit Pi-author and Claude-evaluator placement for startup verification.
- `operations-triage`: input `{"situation":"Describe an incident or operational situation"}`.
- `support-draft`: input `{"title":"Ticket title","body":"Ticket body"}`; output remains a draft.

The validator checks structure and forbidden side-effect fields. It does not establish semantic accuracy or prove that advice is safe to execute. No workflow publishes or executes the proposed actions.

The daily task catalog contains two tasks. `agent-smoke` is an installation diagnostic,
and `task-guide` is the internal read-only conversational helper. The guide has no tools;
it prepares candidate inputs and questions, independently validates its output, and never
starts the proposed task. The Governor validates proposals against the authorized active
catalog and requires explicit human confirmation. Presentation metadata supplies task
names, examples and system visibility. The guide has a 16384-token budget; the ordinary
starter agents retain 8192-token budgets.
