# Run the operational proof

`scripts/verify-operational.sh` runs the end-to-end acceptance path against real
components in disposable directories: real socket, native setup, CLI compile/activation,
the selected engine, actual output uploads, the trusted launcher with Docker, and all
three starter workflows. It fails rather than skipping when a dependency is missing.

## Requirements

- Built tree (`rtk pnpm build`) and sandbox images (`rtk bash scripts/build-sandbox-images.sh`).
- Docker running; the evaluator image must contain Bash and Python.
- A reachable model endpoint for the selected engine.

## Run

```bash
rtk bash scripts/verify-operational.sh
```

Defaults to Pi; select Claude explicitly with `BRAIN_OPERATIONAL_ENGINE=claude`.
Evidence goes to `artifacts/implementation/operational-<timestamp>/`; override with
`BRAIN_OPERATIONAL_EVIDENCE_DIR`.

## What it asserts

For each workflow (`agent-smoke`, `operations-triage`, `support-draft`):

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
