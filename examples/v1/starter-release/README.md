# Operations starter release

Compile this directory with `brain config compile`, inspect the returned digest, then activate it explicitly.

The agents use Pi or Claude and have no tools or child agents. All outputs are checked by a separate deterministic evaluator attempt in the `evaluators` runner group. L1 proves a separate attempt; it does not attest a separate physical host or model quality.

- `agent-smoke`: input `{"message":"BRAIN_OK"}`; exact expected model output is the JSON string `"BRAIN_OK"`.
- `operations-triage`: input `{"situation":"Describe an incident or operational situation"}`.
- `support-draft`: input `{"title":"Ticket title","body":"Ticket body"}`; output remains a draft.

The validator checks structure and forbidden side-effect fields. It does not establish semantic accuracy or prove that advice is safe to execute. No workflow publishes or executes the proposed actions.
