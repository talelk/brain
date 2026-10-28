# 05 — Identity, authorization, approvals and isolation

## Actor construction

Better Auth verifies browser/CLI human sessions. Governor maps the verified user to organization memberships and workspace grants. Organization membership alone does not imply access to every workspace. An explicit capability scope plus workspace membership is required. Never accept `ActorContext` from a client body or trust a caller's requested organization header without membership validation.

Machine enrollment creates a separate runner identity bound to organization, group, allowed configuration and public key/credential. A short-lived runner session is distinct from the persistent identity. Delegated agent/workflow grants contain parent actor, run, workspace, allowed commands, expiry and delegation depth. Delegation intersects privileges and budgets; it never expands them. Default maximum delegation depth is two, maximum four active child jobs per parent, configurable downward by the floor.

Use SameSite secure HttpOnly cookies, exact trusted origins, TLS, CSRF/origin validation on cookie-authenticated mutations and short session revocation propagation. Better Auth handles its own flows under its documented integration; application endpoints also need their own protection. A cached session is not enough for a production approval: recheck membership, role, session status and step-up freshness at decision/permit time. Baseline human step-up freshness is five minutes for production approval, using a configured strong reauthentication method; the concrete auth plugin must pass integration tests before being advertised.

Runner endpoints reject browser cookies. Public auth routes do not expose runner enrollment. Enrollment tokens expire in ten minutes, are one use, hashed at rest, and bound to a specific permitted group. Runner hello cannot self-select a more privileged group. Session credentials rotate and are revoked on quarantine or identity revocation. Credentials never appear in logs or URLs.

## Policy model

Policies evaluate actor, command, workspace, target environment, effect class, pinned tool release, risk, runner trust and current operational restrictions. Result is `allow`, `deny`, or `requires-approval`, plus reason codes and obligations. Deny takes precedence. Missing facts and unknown classifications deny effects. Read-only workflows may use isolated writable scratch space for analysis/builds; read-only refers to governed target effects, not absence of every temporary file write.

Roles: viewer, operator, workspace lead, approver, organization admin, security admin. Separate author and approver for production/high-risk publication by default. Security admin may quarantine; it cannot silently approve its own deployment unless explicitly permitted by the organization's separation-of-duties policy. A bootstrap organization owner is created by a one-time local setup flow with no public default credentials.

An agent can request an operation proposal. It cannot grant approval, alter membership, activate policy or publish an executable tool. Administrative UI edits produce a Git proposal/diff; activation remains a reviewed immutable release. Runtime emergency stop is a narrowing exception stored in control state and audited.

## Exact approval subject

Approval subject includes organization/workspace, operation, pinned tool digest, canonical input digest, stable target ID/environment, target precondition fingerprint, proposed artifact/revision, permitted effect bounds, policy/config digests, expiry and nonce. The server computes the digest. A display summary is rendered from that same canonical subject and checked against its digest.

Request states: pending → approved/rejected/expired/revoked. Approval consumption is a separate immutable row tied to one invocation and permit. The human decision stores actor, authentication evidence reference, exact displayed payload digest, verbatim note, channel and timestamp. “ok” received in model text is not a decision. Request changes creates a new proposal version; it never edits the already-approved subject.

Approvals can expire while a job queues. Revalidate at claim for UX and again immediately before effect authorization. Actor/membership/policy may be revoked after approval. New policy restrictions invalidate grants even for pinned runs. Target drift, changed branch head, changed comment text or tool release requires a new approval. A refreshed evidence timestamp alone may preserve an action only when its bound action and target fingerprints are unchanged and policy explicitly permits refresh.

## Effect permit algorithm

1. Broker prepares exact validated input and authoritative target fingerprint by read-only probe.
2. Request permit using attempt identity, invocation ID, action digest, observed precondition and all required resource keys.
3. In one global BEGIN IMMEDIATE transaction check current runner epoch/lease, membership/revocation, current policy restrictions, exact approval/expiry/use count and conflict locks. Allocate resource-specific fencing counters in sorted key order and record effect intent.
4. Consume approval for this invocation, insert permit and audit/outbox, commit. A repeated identical request returns the same permit; a changed subject conflicts.
5. Broker verifies permit issuer/audience, invocation/attempt, digest, short expiry (default 15 seconds) and resource claims. Credentials are issued/selected only to the narrow trusted tool process.
6. Execute with target CAS/preconditions. Record started/observed effects and durable local receipt, upload evidence, submit outcome. Later effect calls require separate permits.

The selected grant is a 256-bit opaque online capability; authoritative state remains in SQLite. No JWT/offline verification path is required. Derive its pseudorandom bytes using a purpose-specific HMAC-SHA-256 key over the permit ID and a stored random nonce; store the nonce/key ID and a separate token lookup digest, not plaintext. An identical retry can reconstruct the same unexpired token without consuming approval again. Key retirement/revocation denies old permits. Cancellation before effect-start denies execution. Cancellation after mutation may yield unknown or completed-with-cancellation-requested, never fabricated rollback. Document 19 specifies token/session binding.

There is no atomic transaction between SQLite and an arbitrary target. A lost response or consumed permit can leave uncertainty. The product's guarantee is exact authorization, bounded invocation and auditable reconciliation; it must not promise exactly-once external effects.

## Credential topology

General agent slots contain model credentials scoped by provider/project and no production mutation credentials. Prefer a runner-local credential broker/proxy so model children cannot read durable API keys; if an engine requires a credential in environment, use a narrow ephemeral account and treat that slot as capable of exfiltrating it. Redaction does not prevent exfiltration.

Privileged tool slots receive only a narrowly scoped target identity for a version-pinned operation. Do not mount the supervisor's home, cloud CLI profiles, SSH agent, kubeconfig or host Docker socket. Connectivity probes advertise reachability without disclosing secret paths or values. Governor stores secret references; target secrets stay in a protected runner/credential service when possible.

Compose secrets are mounted files, not an encrypted secret vault. Restrict host file permissions, backup encryption, service access and key rotation. A wrapper may translate `_FILE` references to an upstream process environment at startup only when its documented API requires it. Do not assume TencentDB or another library supports arbitrary `_FILE` variables.

## Sandbox and launcher boundary

Compose deploys the supervisor. The selected per-job implementation is a Brain-owned constrained rootless Docker launcher over an authenticated Unix HTTP socket, with the exact protocol and enforced proxy topology in document 20. The agent never receives this socket. Launcher supports only create/stop/inspect with pinned image, confined bind roots, resource limits and predefined egress profiles; no arbitrary host mounts, privileged flag, host network or custom daemon arguments. A dedicated disposable VM remains a separate future isolation profile, not another required launcher choice.

Rootless Docker reduces some host privilege but does not make arbitrary hostile builds safe by itself. Validate cgroups v2 delegation, seccomp, user namespaces, PID/file limits, writable volumes, DNS/egress enforcement and daemon cleanup. Plain Compose bridge networking is **not** an egress allowlist. Use enforced host firewall/proxy or verified network sandbox; DNS rebinding and redirected targets must remain blocked. For high-trust production credentials versus hostile code, use different hosts/VM trust domains.

## Threat-driven controls

| Threat | Required enforcement |
|---|---|
| Prompt injection in repository/ticket/memory | Label untrusted context; broker policy plus OS/network limits independent of instructions |
| Malicious repository hooks/config | Disable hooks and unsolicited extension/config discovery; use pinned harness home and reviewed resources |
| SSRF in connector/Git URL | Allowlisted schemes/hosts, resolve and validate addresses, deny metadata/link-local/internal targets unless explicitly configured, recheck redirects |
| Artifact traversal/archive bomb | Stream limits, no symlinks/hardlinks/device files, confined extraction and total size/file count caps |
| Cross-tenant digest guessing | Authorize artifact association, not hash possession; no shared private cache keys |
| Stale process/daemon | Kernel process tree/cgroup kill and credential revocation; capacity reused only after cleanup proof |
| Forged runner success | Separate evaluator/target readback; compromised runner claims remain candidates |
| Audit tampering | Restricted writer, immutable event chain and periodic signed off-host checkpoint; do not call same-disk append-only “tamper proof” |
| Budget exhaustion/fork storm | Atomic budget reservations, finite child count/depth, process and queue admission |

Secrets are scrubbed before log/artifact/memory publication. Structured-key redaction does not catch all secrets in arbitrary text; apply bounded content scanning and exclude sensitive streams by default. Store redaction profile/version with evidence. Sensitive raw diagnostic capture requires explicit authorized handling and short retention.
