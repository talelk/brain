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

## 4a. Read tools that need data or the network (brokers)

A pinned script runs sandboxed with no network and no Governor access, so a read tool that needs more is
**brokered**: before the script runs, the runner supervisor obtains the data and hands it to the script under a
reserved `broker` key (an agent cannot supply it: the pinned input schema has `additionalProperties: false`).
The script only bounds and shapes what it receives. A refusal is a failed call with a receipt, never a script run on
missing data.

| Tool | Broker | What the broker enforces |
|---|---|---|
| `documents.read` | Governor (`POST /runner/v1/attempts/:id/tool-read`) | live attempt, the attempt's agent lists the exact tool digest, document is in the attempt's workspace and not revoked, size bound. Also reads a context reference (`artifact:sha256:...`) stored with the workspace's context packs |
| `csv.query` | Governor | artifact is a verified text row of the workspace, size bound; the script loads only that CSV into an in-memory SQLite table `data` behind an authorizer (no write, attach, pragma or other table) with a 5 s limit |
| `knowledge.search` | Governor | mission scope rechecked, bounded ranked hits with provenance |
| `web.fetch` | runner (network) | GET only; host must equal an entry of the Tool document's `allowedHosts` (re-checked on every redirect, at most 3); public addresses only (loopback, private, link-local and metadata ranges refused at connect time); 10 s per hop; 1 MiB counted while streaming; readable text content types only |

Refusals by the Governor are written to the audit trail as `tool.read.refused` (tool, attempt, reason). Calls appear
as the usual `tool.proposed` / `tool.result` events with receipts and in the evidence bundle's tool releases.

A Tool document may carry `description` (shown in the registry) and `allowedHosts` (network tools). To add a new
brokered tool, add its id to `GOVERNOR_BROKERED` / `RUNNER_BROKERED` (`apps/runner/src/tools/brokers.ts`) and, for the
Governor kind, a branch in `apps/governor/src/modules/jobs/tool-reads.ts`.

## 4b. Tools that reach the host (ADR 0021)

| Tool | What it can do | Where the limit lives |
|---|---|---|
| `host.read` | list, read (text) and find files under the host's `/srv` | the launcher mount is read-only and operator-declared (`BRAIN_LAUNCHER_DATA_MOUNTS=srv=/srv`); the runner gives it to this tool only (`BRAIN_TOOL_DATA_MOUNTS=host.read=srv`); the pinned script denies secrets, databases, archives and backups, resolves symlinks, redacts secret-looking values |
| `host.exec` | run one named read-only diagnostic (`docker.ps`, `docker.logs`, `host.df`, `systemd.status`, `http.head-public`, ...) | the operator's `host-commands.json` on the launcher fixes the argv and each argument's pattern; the tool's input schema lists the allowed names; no shell |

Add a command in `scripts/demo/host-commands.json` and `schemas/host-exec-input.json`, restage the release and redeploy. Restart/reload commands must be `privileged` and go through a privileged tool (an effect permit per call).

## 4c. Effect tools (ADR 0024)

A tool with effect class `write` or `privileged` changes something outside Brain, so each call stops for a person. It also needs an
operator policy in `apps/governor/src/modules/governance/effects.ts` (its plain-words summary, the check of its arguments, what it
touches) and a broker: a named privileged command on the launcher (`LAUNCHER_EFFECTS` in `apps/runner/src/tools/effects.ts`,
`host-commands.json` on the launcher host) or a Governor-side port (`application/effect-broker.ts`: tickets, messages, pull requests).
The pinned `run.sh` only shapes the broker's answer from `broker`, as for read tools. Stage a `test.sh` too: the product runs it as the tool's
self-test (`POST /v1/config/tools/:id/selftest`). The owner sets what a call may touch (`workspace.effects.set`) and which runner group
carries host tools (`runnerGroup.set`).

## 5. Verify

```bash
rtk bash scripts/verify-operational.sh
```

The proof runs `operations-triage` end to end and asserts the governed broker path:
the evidence bundle must pin `operations.context` and the run must record the
broker's tool events. Add your own workflow/agent to extend the same assertion.
