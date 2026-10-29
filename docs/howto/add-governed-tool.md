# Add a governed tool

A tool is a release-pinned script that an Agent may invoke only through the governed
broker. Native Pi/Claude host tools stay disabled; nothing reaches the host or a
sandbox that the release did not declare.

## 1. Declare the Tool document

```yaml
# config/operations.context.yaml
apiVersion: brain.keyrus/v1
kind: Tool
metadata: { id: operations.context, version: 1.0.0 }
spec:
  effectClass: read            # read | write | privileged
  inputSchemaRef: schemas/context-input.json
  outputSchemaRef: schemas/context-output.json
  requiredCapabilities: ["tool:bash", "tool:python3"]
  timeoutSeconds: 10
  maxOutputBytes: 4096
  allowedEnvironments: ["local"]
  entrypoint: run.sh
```

`effectClass` must be one of `read`, `write`, `privileged`; the compiler rejects
anything else. The first `allowedEnvironments` entry becomes the pinned execution
target. Schemas must be confined files inside the release.

## 2. Stage the script

Place the entrypoint at `tools/<tool-id>/<entrypoint>` (here
`tools/operations.context/run.sh`). `brain config compile` stages the bytes; the
compiler pins `sha256(script bytes)` next to the Tool document digest. The runner
fetches only these pinned bytes over the authenticated runner protocol.

## 3. Allowlist it in an Agent

```yaml
spec:
  tools:
    - { id: operations.context, digest: "sha256:<tool-document-digest>" }
```

Then update every workflow that references this Agent, because the workflow pins the
Agent document digest. The Operations Assistant in the starter release is the working
example.

## 4. What the broker enforces at execution time

1. The engine exposes the tool as `brain_<tool-id>` with the pinned input schema.
2. A model proposal emits `tool.proposed` with the tool release, target, and input digest.
3. The runner supervisor re-checks: the tool is in the Agent's allowlist at the exact
   digest, the proposal target equals the pinned target, and the input validates against
   the pinned schema.
4. `write`/`privileged` tools additionally require a Governor-issued effect permit,
   re-validated immediately before exec. `read` tools never request one.
5. Execution is sandboxed through the trusted launcher. Without a launcher, effect-class
   execution fails closed; it never runs as host bash.
6. Output is uploaded as an immutable artifact, recorded in the evidence bundle's
   `toolReleases`, and returned to the engine with a receipt.

Invocation count is bounded by the Agent's `maxTurns`; output by `maxOutputBytes`;
execution by the step timeout. Any mismatch (unauthorized id/digest, wrong target,
schema rejection, refused permit) aborts the tool call, not the run silently.

## 5. Verify

```bash
rtk bash scripts/verify-operational.sh
```

The proof runs `operations-triage` end to end and asserts the governed broker path:
the evidence bundle must pin `operations.context` and the run must record the
broker's tool events. Add your own workflow/agent to extend the same assertion.
