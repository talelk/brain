# 06 — Capability-aware runners, scheduling and leases

## Runner model

A runner is a registered execution resource, not an agent definition, workspace daemon or GitHub runner binary. A supervisor connects outbound over HTTPS, probes its environment and manages isolated slots. Slots default to one per runner. Additional slots need independent filesystem/process/credential isolation and measured capacity. Group membership is administrator-bound, never inferred from advertised labels.

Persist administrative state (`enabled|draining|quarantined|disabled`), connectivity (`online|offline`) and allocated slots independently. Display priority is disabled/quarantined, offline, draining, busy, idle. A draining busy runner must remain visibly both draining and occupied. Health (`healthy|degraded|unhealthy`) and probe freshness are additional admission facts.

Observed labels use a versioned taxonomy: `os:linux`, `arch:amd64`, `engine:pi`, `protocol:acp-v1`, `tool:kubectl`, `network:oci-prod`, `isolation:ephemeral-container`. Labels route work; trust claims require a verified binding/probe. Each capability has source, observed time, verification status and expiry. A connectivity probe proves a read path at an observation time, never broad production permission.

## Enrollment and epoch semantics

An admin issues a one-time enrollment token for an organization/group and expected trust profile. Runner creates a persistent identity credential in protected local storage. `hello` authenticates that identity, validates supported protocol/runtime and advertises observed resources. Governor assigns the session epoch; runner cannot choose a larger value to steal a session. Repeated hello with the same boot nonce is idempotent; a new boot establishes a new epoch and invalidates the old session.

An old session's active effects become suspect when the epoch changes. Do not silently attach a running privileged process to a new epoch. Reconcile/terminate it first. Quarantine revokes the session and sends stop commands; an offline compromised runner still needs target credential revocation. Heartbeats contain session epoch, increasing sequence and active attempt IDs. Duplicate sequence/same hash is accepted idempotently; older or changed payload is rejected.

Defaults: heartbeat every 15 seconds with jitter; offline after 45 seconds without valid heartbeat; offer ACK deadline 10 seconds; execution lease 60 seconds; renewal every 15 seconds. Only server-derived deadlines authorize. Runner budgets a conservative local stop time from the received lease duration using monotonic time and a safety margin. A 15-second renewal failure triggers degraded mode; at the local safe deadline it stops work. Target write permits are much shorter than the job lease.

## Admission predicate

Before ranking, require: job queued and deadline/budget valid; workspace active; organization/group permitted; runner admin enabled/healthy/online/fresh; verified capabilities satisfy all/anyOf; engine ABI/features compatible; observed capacity and authoritative reservations fit; isolation/trust profile allowed; target connectivity fresh; policy/current approval valid where required; no unresolved conflicting effect guard. Runner independently rechecks local pressure and may decline before spawn.

Numeric admission uses reserved resources, not trusting a reported “available” number alone. Available = min(verified capacity minus reserve minus committed reservations, conservative observed free). Reserve a system baseline of 1,024 MiB and 500 millicores by default, configurable to measured host size. Disk and GPU memory are reserved too. Reject negative, overflow, NaN, missing required values and a slot count inconsistent with approved host limits.

Agent and privileged tool groups use distinct execution classes. General model-generated shell is never eligible on a privileged group. Eval groups must meet the configured independence level. Capability edits do not automatically change the group's trust policy.

## Fairness and ranking

Within hard eligibility, choose workspace by weighted deficit round robin, then job by priority plus bounded age, then runner by locality/headroom/cost/stability. Use deterministic runner-ID tie breaking. Job priorities are bounded classes, not arbitrary caller-provided integers. Interactive work cannot starve scheduled checks; reserve one small house capacity lane when host capacity permits and cap house work to a declared budget. Never run a heavy build under a fake house profile.

Maintain capability/group indexes and queue-ready indexes; do not scan every runner against every job on each heartbeat. Recompute on relevant state changes and periodic reconciliation. Start with at most 100 ready candidates per claim and instrument rejected-candidate reasons. If this bound hides eligible work, advance a durable fair cursor, never always rescan the same first page. A 25-second long poll wakes on queue change; the notification is advisory and claim still uses SQLite authority.

## Atomic offer and ACK

Claim transaction rechecks runner epoch, job version, policy admission and reservations. Allocate a new attempt number, a job-level fence, capacity reservation and offer expiry. Exactly one active attempt per job is protected by a partial unique index. Offer response includes pinned config/IR execution artifact, placement, resource reservation and execution grant reference; it does not contain plaintext target credentials or a consumed production approval.

ACK requires attempt/lease ID, epoch, job fence and unexpired offer. It changes offered → running and establishes execution expiry. Duplicate ACK returns existing lease. A decline with a reason releases only owned reservations and returns job to queue if safe. Expired offers are not external-effect attempts; they can requeue after cleanup/absence of spawn is established. Runner must not spawn before ACK succeeds.

Resource conflicts for external operations are acquired at effect permit time, in sorted canonical resource-key order. Long analysis jobs do not hold production mutation locks. Git writer locks for a local worktree are local slot isolation; remote merge locks are global canonical repository/ref resources. Cross-workspace references to the same remote target must map to the same authoritative target ID so two differently named workspaces cannot bypass a merge lock.

## Fencing, stop and cleanup

Every lockable target has a permanent monotonically increasing counter; deleting a lease never resets it. A lease contains resource key, fence, owning invocation/attempt and expiry. Job fence and per-resource fences are distinct fields. All result/renewal/permit calls require the current job fence. External target CAS uses resource-specific preconditions/fences where supported.

A lease expiry proves loss of Brain authority; it does not prove process death or target nonexecution. Keep an unresolved effect guard after expiry until the launcher proves termination and the target reconciler resolves ambiguity. Thus another job may remain blocked even when the timestamp lease is expired. For read-only scratch work, cleanup proof is enough to release compute. Do not trust a runner's incomplete cleanup message to reuse a dirty slot.

Cancellation is a durable desired state with a stop command, not immediate terminal success. Runner sends SIGTERM, waits five seconds by default, then SIGKILLs the owned cgroup/container and verifies no descendants remain. Privileged credentials are revoked. A tool that already mutated may still complete, fail or remain unknown. UI shows cancellation requested until termination/outcome is known.

## Explain placement

Return a versioned explanation snapshot with evaluatedAt, job version, all applicable blocker codes and per-runner redacted reasons. Unauthorized users see only runners/groups they may inspect. Never leak internal hostnames/capabilities for another tenant.

Primary queue reason precedence: policy denial/required approval, unresolved effect conflict, no matching verified runner, unhealthy/offline matching runners, insufficient capacity, fairness/budget delay. Preserve the full reason array. `WAITING_FOR_RUNNER`, `BLOCKED_BY_POLICY`, `WAITING_FOR_APPROVAL`, `INSUFFICIENT_CAPACITY`, `WAITING_FOR_RESOURCE`, `BUDGET_EXHAUSTED` are distinct; “queued” alone is inadequate.

## Current-build identity and restart

Drain/quarantine remain runtime administration actions. A restarted runner keeps its identity and establishes a new session epoch; current-build recovery rechecks active attempts instead of silently adopting stale authority. Active attempts pin their tool/harness/config for execution and evidence. No rolling-upgrade strategy, historical session conversion or old/new runtime coexistence is required. Capability probes have TTL (default five minutes for connectivity, one hour for static tool versions), but a failed probe invalidates immediately. Hello validates the one supported target contract and refuses mismatches.
