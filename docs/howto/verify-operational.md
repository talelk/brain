# Run the operational proof

`scripts/verify-operational.sh` runs the end-to-end acceptance path against real
components in disposable directories: real socket, native setup, CLI compile/activation,
the selected authoring engine, actual output uploads, the trusted launcher with Docker,
and all four user/diagnostic starter workflows. It fails rather than skipping when a
dependency is missing.

## Requirements

- Built tree (`rtk pnpm build`) and sandbox images (`rtk bash scripts/build-sandbox-images.sh`).
- Docker running; the evaluator image must contain Bash and Python.
- A reachable model endpoint for the selected engine and a Claude endpoint/credential for the evaluator runner. The managed TencentDB proxy supplies both by default.

## Run

```bash
rtk bash scripts/verify-operational.sh
```

Defaults to Pi authoring; select Claude authoring explicitly with `BRAIN_OPERATIONAL_ENGINE=claude`.
Evidence goes to `artifacts/implementation/operational-<timestamp>/`; override with
`BRAIN_OPERATIONAL_EVIDENCE_DIR`.

## What it asserts

For each workflow (`agent-smoke`, `runner-topology-smoke`, `operations-triage`, `support-draft`):

1. Dispatch returns a durable run id; the author runner claims the agent job and an
   independent evaluator runner claims the validation job.
2. The workflow reaches `succeeded` only with accepted independent evidence — a model
   completion or runner exit alone cannot pass.
3. An evidence bundle and verification verdict exist; the accepted output matches the
   pinned schema and the deterministic validator.
4. For `operations-triage`, the evidence must pin the governed `operations.context`
   release and the run must record the broker's tool events.
5. The source fingerprint is stable across the run; the final `run.json` records head,
   fingerprints, commands, run/attempt/evidence ids, output digests, and model events.

On failure, the evidence directory holds `failure.txt`, per-run `*-failure.json`, and
diagnostics with the relevant jobs, outputs, events, and verdicts.

## Related checks

```bash
rtk pnpm verify:full                     # typecheck, boundaries, unit/integration/security/chaos/certification/browser
rtk python3 scripts/generate_contract_types.py --check
rtk bash examples/v1/starter-release/tools/operations.validate/test.sh
```

Browser workflows use the deterministic fixture engine and establish UI behavior
separately from live model proof.

## Verify the guided local setup

For the generated administrator/workspace path, run:

```bash
rtk node --import tsx scripts/verify-local-setup.ts
```

This proof starts a disposable checkout installation through `pnpm brain start`,
signs in with the default administrator credential without a forced change, connects
the configured live model via the same endpoint used by the browser, and waits for the automatically paired task
runner and validator. It runs smoke, operational investigation and support drafting,
requires verified evidence, checks a live conversation proposal stays inert until
confirmation, and completes a task linked to a work item. It stops and restarts the
installation to check retained identity, settings and runner enrollment, then resets
the disposable instance and verifies fresh defaults replace the previous state. It
also verifies the backup shortcut, preservation of that backup through reset, and
restoration with execution suspended. A failed or rejected result fails the proof.
It never substitutes the fixture engine for model execution.

Use `BRAIN_LOCAL_MODEL_URL` and `BRAIN_LOCAL_MODEL_ID` for the live endpoint. Docker
must be available. Evidence is written to `artifacts/implementation/local-setup-<time>/`;
`BRAIN_LOCAL_SETUP_EVIDENCE_DIR` overrides that location. Disposable instance data is
retained under the `/tmp/brain-local-setup-proof-*` path recorded in `run.json`; owned
processes are stopped in teardown. Treat the retained instance as private operational
state, since it contains native sessions and runner credentials.
