# Keyrus Brain RFC-041 — Capability-Aware Runner Plane

**Status:** Proposed architectural amendment to Keyrus Brain v4.0  
**Date:** 2026-10-26  
**Scope:** Runner inventory, registration, dispatch, permissions, leases, placement, isolation, scheduling, recovery.  
**Source of truth:** YAML/Git for declaration; global SQLite for operational execution authority; per-workspace SQLite for projections/results.

## 1. Decision

Model runners after GitHub Actions self-hosted runners: registered execution endpoints that advertise capabilities, belong to groups/pools, accept jobs selected by declarative constraints, and send heartbeats, events and evidence. They are not workspace-owned infrastructure services or AI agent instances.

Extend the GitHub Actions model with:
- capability classes and verified connectivity;
- AI engine/protocol support (Pi RPC, Claude, ACP, other adapters);
- trust-domain separation, environment and effect authorization;
- resource reservations and slots;
- durable leases and fencing tokens;
- ephemeral, sandboxed job execution;
- explainable placement and reconciliation;
- support for asynchronous, suspended agent workflows.

**Non-goal:** Reuse the GitHub Actions runner process as Brain's mandatory runner. It is coupled to GitHub workflow control and does not natively implement Brain's agent-session, environment approval and evidence protocols. GitHub Actions can be an optional execution backend for repository-specific jobs.

## 2. Boundaries

| Boundary | Authority | Contract |
|---|---|---|
| Git → Config Compiler | Definition and approval of runner groups, policies, placement rules, constraints | RunnerPool YAML, JobPlacement YAML |
| Runner → Governor | Observed runtime facts, heartbeat, capacity and outcomes (untrusted until verified) | RunnerHello, Heartbeat, JobClaim, JobEvent, JobReceipt |
| Governor → Runner | Eligible job offer, scoped authorization, deadline and lease | JobOffer, ExecutionPermit |
| Governor → Policy | Allowed actor, workspace, target, effect, network, tool, engine | PlacementDecision and AuthorizationDecision |
| Governor → Mastra | Resolve eligible external step and send completion/suspension events | WorkflowEnginePort |
| Runner → Engine | Harness-neutral session specification and engine event stream | EngineAdapter |
| Runner → Tool Broker | Authorized version-pinned tool execution | ToolInvocation, ToolReceipt |
| Governor → SQLite | Scheduler, lease, audit and approval authority | Transactions in control.db |
| Workspace DB ← Governor | Work history, evidence, workflow projection | Versioned idempotent events |

A runner never reads or writes a central SQLite file directly. Workers communicate with Governor via HTTPS. Runner reports are treated as evidence candidates; Governor independently verifies authoritative operations.

## 3. Capability taxonomy

1. **Platform:** os, architecture, container engine, GPU type, cgroups, installed toolchains.
2. **Agent engine:** pi, claude, opencode, ACP, streaming, steering/resume support.
3. **Tooling:** bash, git, kubectl, helm, playwright, build/test profiles.
4. **Connectivity:** Git host, target Kubernetes context, internal network reachability, local model endpoints.
5. **Isolation/trust:** approved runner group, security tier, isolation modes, separation from untrusted workloads.
6. **Capacity (numeric):** CPU, memory, ephemeral disk, GPU free memory, max slots and current reserved resources.

**Key rule:** Advertised capabilities are facts or claims used for *routing*. Granted privileges are separately verified and authorized by the Governor. A string label must never confer access by itself. Secrets and credentials are provisioned through scoped trusted paths and are not derived from a runner-supplied label.

## 4. Runner group configuration (Git)

```yaml
apiVersion: brain.keyrus/v1
kind: RunnerGroup
metadata:
  id: oci-operations
spec:
  allowedWorkspaces: [orange-oci]
  allowedJobClasses: [analysis, build, test, diagnostics]
  isolationRequired: ephemeral-container
  maxJobRuntimeMinutes: 120
  admission:
    maxParallelPerRunner: 1
    reserveMemoryMb: 1024
  security:
    maxRisk: medium
    forbidPersistentWorkspaceCredentials: true
    forbidUnreviewedProductionWrites: true
```

Git configuration describes allowed group behavior and safe bounds, not a factual claim that a physical runner is online.

## 5. Job placement syntax (Git)

```yaml
jobs:
  investigate:
    runsOn:
      group: oci-operations
      all: [os:linux, tool:kubectl, isolation:ephemeral]
      anyOf: [engine:pi, engine:claude]
      resources:
        cpu: 2
        memoryMb: 4096
      affinity:
        prefer: [local-repository-cache, workspace-locality]
    uses: brain.agent-task
    with:
      mode: read-only
      task: Investigate pod restarts
```

`all` is logical AND; `anyOf` is logical OR for alternate capabilities. Group membership and the security constraints are additional conjunctive checks. Anti-affinity, placement preferences and scoring cannot override hard constraints.

## 6. Contracts

```ts
export type RunnerState =
  | 'registered' | 'online' | 'busy' | 'draining'
  | 'offline' | 'quarantined' | 'disabled';

export interface RunnerHello {
  protocolVersion: 'brain.runner.v1';
  runnerId: string;
  registrationId: string;
  runtimeVersion: string;
  configHash: string;
  observedCapabilities: string[];
  engines: Array<{
    id: string;
    version?: string;
    features: string[];
  }>;
  capacity: { cpuMillicores: number; memoryMb: number; diskMb: number; slots: number };
  isolationModes: string[];
}

export interface RunnerHeartbeat {
  runnerId: string;
  sessionEpoch: number;
  sequence: number;
  observedAt: string;
  health: 'healthy' | 'degraded' | 'unhealthy';
  available: { cpuMillicores: number; memoryMb: number; slots: number };
  activeAttemptIds: string[];
}

export interface JobPlacement {
  group: string;
  all: string[];
  anyOf?: string[];
  resources: { cpuMillicores: number; memoryMb: number; diskMb?: number };
  isolation: 'ephemeral-container' | 'dedicated-vm' | 'trusted-local';
  targetRef?: string;
  riskTier: 'read' | 'write' | 'privileged';
}

export interface JobOffer {
  jobId: string;
  attemptId: string;
  runnerId: string;
  runnerEpoch: number;
  leaseId: string;
  fencingToken: number;
  leaseExpiresAt: string;
  workspaceId: string;
  configCommit: string;
  configHash: string;
  engineRequirement: { anyOf: string[]; features: string[] };
  resourceReservation: { cpuMillicores: number; memoryMb: number };
  execution: { kind: 'agent' | 'tool' | 'eval'; artifactDigest: string };
  permitRef: string;
}

export interface JobReceipt {
  jobId: string;
  attemptId: string;
  leaseId: string;
  fencingToken: number;
  status: 'succeeded' | 'failed' | 'cancelled' | 'unknown-outcome';
  eventSequence: number;
  evidenceDigest: string;
  artifactRefs: string[];
  externalEffects: Array<{ target: string; operation: string; status: string }>;
}
```

`permitRef` identifies scoped and expiring authorization. The runner must resolve and verify it at the tool broker. A receipt alone is not evidence of successful or authorized effects.

## 7. Placement predicate and scoring

**Eligibility (all hard checks must pass)**
1. Runner registered, group permitted, enabled, trusted and online.
2. Group and workspace access match a verified binding.
3. All required labels present; anyOf is satisfied if specified.
4. Engine feature/ABI versions meet job requirements.
5. Capacity reservation fits available CPU/RAM/disk/slots.
6. Isolation and risk requirements are met.
7. Target connectivity is health-checked; secrets/credentials available through trusted grant.
8. Job-level approval and policy requirements satisfied.
9. No conflicting authoritative resource lease exists.

**Ranking only after eligibility:** data/repo locality, warm tool cache, capacity headroom, fairness by workspace, remaining budgets, historical failure rate, cost. Always provide a human-readable explain-plan showing each rejection reason.

## 8. Runner and attempt state machines

Runner: `registered → online → busy → online`; `online/busy → draining → offline`; any state → quarantined/disabled with explicit administrative policy. Heartbeat expiry implies offline; a busy runner's active attempts become suspect, not immediately successful or failed.

Attempt: `queued → offered → leased → running → uploading → verifying → succeeded`. Alternate transitions: `offered → queued` on no ACK; `leased/running → cancelling`; `running → unknown-outcome` on lost control during unconfirmed external effect; `verifying → failed` if evidence gate fails. Never blindly retry write attempts after unknown outcome.

## 9. Transport (outbound runner only)

Suggested HTTPS endpoints:

- `POST /runner/v1/hello` — authenticated capability inventory / epoch establishment.
- `POST /runner/v1/heartbeat` — capacity, health, active attempts.
- `POST /runner/v1/claim` — atomic, policy-checked job offer/claim.
- `POST /runner/v1/attempts/{id}/start` — ACK with lease and epoch.
- `POST /runner/v1/attempts/{id}/events` — ordered, deduplicated execution events.
- `POST /runner/v1/attempts/{id}/heartbeat` — bounded lease renewal.
- `POST /runner/v1/attempts/{id}/complete` — receipt and evidence references.
- `POST /runner/v1/attempts/{id}/release` — release resources/locks with token validation.

Use HTTPS long polling or an outbound event stream to signal available work; always maintain durable queue state in SQLite. A network event is a notification, not a source of truth. A runner registration secret must not be committed to Git. Rotate session credentials and invalidate them on quarantine.

## 10. Operational tables (Global SQLite)

- `runner_registrations` — identity, pool/group binding, active status and approved config version.
- `runner_sessions` — runner epoch, heartbeat, online status and identity binding.
- `runner_capabilities` — observed/verified capabilities with source, timestamp and expiry.
- `runner_resources` — current capacity and atomic reservations.
- `jobs` — authoritative queued work and placement constraints snapshot.
- `job_attempts` — claims, lease, runner, state, retries, interruption history.
- `resource_leases` — ownership and monotonic fencing tokens.
- `approval_ledger` — content-bound authorizations.
- `runner_events` and `outbox` — ordered audit and workspace projections.

Authoritative job claim/reservation/lock acquisition must occur inside one short global SQLite transaction. The workspace DB is updated asynchronously and idempotently from durable global events. Never assume atomicity across independent WAL databases.

## 11. Trust-domain isolation

Separate **agent runners** (read/analyze/build/test) from **privileged operation runners** (reviewed production actions). A runner capable of contacting a production target should not execute arbitrary model-generated shell commands under production credentials. The production runner accepts only approved, version-pinned operations, with scoped identities and exact-target approvals. Security enforcement uses container/OS/network controls, not self-declared runner labels.

For untrusted code, prefer disposable execution containers or clean VMs. A persistent control process may manage repeated jobs, but one job should not inherit another's sensitive filesystem or credentials. GitHub's documentation separately warns of persistent compromise risk for self-hosted runners.

## 12. Failure semantics

- No ACK: offer expires and returns to queue after expiration.
- Runner disconnects: heartbeat TTL expires; attempt lease is revoked or marked suspect.
- Agent subprocess killed: report cancellation when confirmed; release only owned reservations.
- Crash after external write: mark unknown outcome and run target-specific reconciliation; do **not** automatically reissue the write.
- Stale runner after lease expiry: reject events and receipts with wrong epoch/fencing token; ensure credential expiry or target-side preconditions prevent external stale writes where possible.
- New runner config: apply on restart/registration, respecting active job pins.
- Runner draining: no new leases; allow bounded completion then terminate or escalate.
- Governor restart: recover persistent queue/lease state and reconnect via runner heartbeats.

## 13. UI/CLI

Web, mobile, CLI and MCP must show: runner groups, online/idle/busy/draining, verified capabilities, resources, engines, jobs, failures, evidence, workspace eligibility, and a **Why no runner matched?** explanation.

Example CLI:

```sh
brain runner list
brain runner describe oci-runner-01
brain runner capabilities oci-runner-01
brain runner drain oci-runner-01
brain job explain job-123
brain job dispatch workflow:incident-investigation --workspace orange-oci
```

CLI and MCP dispatch are Governor commands subject to the same actor policy; raw labels do not bypass authorization.

## 14. Implementation order

1. RunnerGroup/JobPlacement schemas and config compiler.
2. Runner identity, hello, heartbeat and epoch handling.
3. Single atomic placement/claim/reservation/lease transaction.
4. Attempt/receipt/evidence contract and retry classification.
5. Engine adapters (Pi/Claude/ACP) and isolated sandbox job slot.
6. Git worktree exclusivity; privileged tool runner separation.
7. Drain/quarantine/offline recovery and explainable scheduling.
8. Capacity fairness and benchmark tuning.

## 15. Acceptance gates

- Jobs only match runners satisfying group, labels, capability and policy constraints.
- An agent cannot grant privileged eligibility by advertising a new label.
- Two runners cannot both hold one authoritative resource lease simultaneously.
- Stale lease owners cannot commit results; external stale writes are mitigated with target-side checks or credential revocation.
- Suspended approvals do not occupy runner slots or hold long-lived resource locks.
- A crashed runner does not silently duplicate side-effecting actions.
- An ephemeral job cannot see previous-job secrets/artifacts.
- A runner can be drained and quarantined without losing workflow history.
- Two engine adapters satisfy the same JobOffer and JobReceipt contracts.
- Workspaces retain exportability: runner registrations remain global; workspace jobs/evidence are projected per workspace.

## 16. Documentation basis

GitHub Actions routing documentation: https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job  
GitHub self-hosted runner reference: https://docs.github.com/en/actions/reference/runners/self-hosted-runners  
GitHub self-hosted runner hardening: https://docs.github.com/en/actions/reference/security/secure-use
