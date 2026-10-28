import { createHmac, randomBytes } from "node:crypto";
import type { JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import type { Store } from "../../application/store";
import type { BrainAuth } from "../identity/index";
import { approvalCurrentlyUsable } from "./approval-authority";
import { assertAttemptLive, loadAttempt } from "../jobs/index";

/**
 * Effect permits: short-lived, current-authority-bound authority for one
 * privileged invocation (E046/E055/E059). Private files; the public surface
 * is the governance module index.
 */
export function issuePermit(s: Store, deps: { auth: BrainAuth }, runner: { runnerId: string; epoch: number; organizationId: string }, attemptId: string, body: Record<string, unknown>): JsonValue {
  const invocationId = String(body["invocationId"] ?? "");
  const subjectDigest = String(body["subjectDigest"] ?? "");
  const approvalId = body["approvalId"] ? String(body["approvalId"]) : undefined;
  // E059: canonical conflict identity — differently-cased or slash-suffixed
  // aliases of one physical target collapse to the same resource key.
  const resourceKeys = [...new Set(((body["resourceKeys"] as string[] | undefined) ?? [])
    .map((k) => k.trim().toLowerCase().replace(/\/+$/u, "")))].sort();
  if (!invocationId || !subjectDigest) throw new BrainDomainError("INVALID_ARGUMENT", "invocationId and subjectDigest required");
  let out: JsonValue = null;
  s.inTx(s.control, () => {
    const prior = s.control.prepare("SELECT id, subject_digest, expires_at_ms, state FROM effect_permits WHERE invocation_id=?").get(invocationId) as
      | { id: string; subject_digest: string; expires_at_ms: number; state: string } | undefined;
    if (prior) {
      if (prior.subject_digest !== subjectDigest) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "invocation reused with different subject");
      const cred = s.control.prepare("SELECT token_nonce, key_id FROM permit_credentials WHERE permit_id=?").get(prior.id) as { token_nonce: string; key_id: string } | undefined;
      const token = cred ? createHmac("sha256", s.pepper).update(`${prior.id}\n${cred.token_nonce}`).digest("base64url") : "";
      const owner = s.control.prepare("SELECT attempt_id FROM effect_permits WHERE id=?").get(prior.id) as { attempt_id: string };
      if (owner.attempt_id !== attemptId) throw new BrainDomainError("FORBIDDEN", "permit belongs to a different attempt");
      assertAttemptLive(s, runner, loadAttempt(s, attemptId));
      if (!validatePermit(s, deps, token, invocationId)) throw new BrainDomainError("APPROVAL_REQUIRED", "permit is no longer current; re-authorize before effect");
      out = { permitId: prior.id, invocationId, token, expiresAt: iso(prior.expires_at_ms), state: prior.state } as unknown as JsonValue;
      return;
    }
    const row = loadAttempt(s, attemptId);
    assertAttemptLive(s, runner, row);
    if (String(row["state"]) !== "running") throw new BrainDomainError("CONFLICT", "attempt not running");
    // E046: a quarantined/disabled runner can never mint fresh effect authority.
    const runnerRow = s.control.prepare("SELECT admin_state FROM runners WHERE id=?").get(runner.runnerId) as { admin_state: string } | undefined;
    if (!runnerRow || runnerRow.admin_state === "quarantined" || runnerRow.admin_state === "disabled") {
      throw new BrainDomainError("FORBIDDEN", "runner is quarantined/disabled; permits denied");
    }
    const org = s.control.prepare("SELECT revocation_generation FROM organizations WHERE id=?").get(runner.organizationId) as { revocation_generation: number };
    let consumedApproval: string | undefined;
    if (approvalId) {
      const ap = s.control.prepare("SELECT subject_digest, state, expires_at_ms FROM approval_requests WHERE id=? AND organization_id=?").get(approvalId, runner.organizationId) as
        | { subject_digest: string; state: string; expires_at_ms: number } | undefined;
      if (!ap) throw new BrainDomainError("NOT_FOUND", "approval not found");
      if (ap.subject_digest !== subjectDigest) throw new BrainDomainError("CONFLICT", "approval subject mismatch; new approval required");
      if (ap.state !== "approved") throw new BrainDomainError("APPROVAL_REQUIRED", "approval not approved");
      if (ap.expires_at_ms <= s.now()) throw new BrainDomainError("APPROVAL_EXPIRED", "approval expired before effect");
      if (!approvalCurrentlyUsable(s, deps.auth, { approvalId, organizationId: runner.organizationId, workspaceId: String(row["workspace_id"]), subjectDigest })) throw new BrainDomainError("APPROVAL_REQUIRED", "approval reviewer authority, session or step-up changed; re-authorize before effect");
      const used = s.control.prepare("SELECT approval_id FROM approval_consumptions WHERE approval_id=?").get(approvalId);
      if (used) throw new BrainDomainError("CONFLICT", "approval already consumed");
      consumedApproval = approvalId;
    }
    for (const key of resourceKeys) {
      const lease = s.control.prepare("SELECT expires_at_ms, unresolved_effect FROM resource_leases WHERE resource_key=?").get(key) as
        | { expires_at_ms: number; unresolved_effect: number } | undefined;
      if (lease && (lease.unresolved_effect === 1 || lease.expires_at_ms > s.now())) {
        throw new BrainDomainError("CONFLICT", `resource ${key} is guarded by a live or unresolved effect`);
      }
      s.control.prepare("INSERT INTO resource_fences(resource_key, organization_id, counter) VALUES (?,?,1) ON CONFLICT(resource_key) DO UPDATE SET counter=counter+1")
        .run(key, runner.organizationId);
      const fence = s.control.prepare("SELECT counter FROM resource_fences WHERE resource_key=?").get(key) as { counter: number };
      if (!Number.isSafeInteger(fence.counter)) throw new BrainDomainError("INTERNAL_ERROR", "resource fence exhausted");
      s.control.prepare("INSERT OR REPLACE INTO resource_leases(resource_key, attempt_id, invocation_id, fence, expires_at_ms, unresolved_effect) VALUES (?,?,?,?,?,1)")
        .run(key, attemptId, invocationId, fence.counter, s.now() + 60_000);
    }
    const permitId = s.id("permit");
    const expires = s.now() + 15_000;
    s.control.prepare(`INSERT INTO effect_permits(id, invocation_id, attempt_id, subject_digest, approval_id, state, revocation_generation, expires_at_ms, created_at_ms)
      VALUES (?,?,?,?,?,'issued',?,?,?)`).run(permitId, invocationId, attemptId, subjectDigest, consumedApproval ?? null, org.revocation_generation, expires, s.now());
    if (consumedApproval) {
      s.control.prepare("INSERT INTO approval_consumptions(approval_id, invocation_id, attempt_id, subject_digest, consumed_at_ms) VALUES (?,?,?,?,?)")
        .run(consumedApproval, invocationId, attemptId, subjectDigest, s.now());
    }
    const nonce = randomBytes(16).toString("base64url");
    const token = createHmac("sha256", s.pepper).update(`${permitId}\n${nonce}`).digest("base64url");
    s.control.prepare("INSERT INTO permit_credentials(permit_id, token_digest, token_nonce, key_id, audience, request_digest) VALUES (?,?,?,'key-1','tool-broker',?)")
      .run(permitId, s.tokenDigest("permit", token), nonce, subjectDigest);
    out = { permitId, invocationId, token, expiresAt: iso(expires), state: "issued" } as unknown as JsonValue;
  });
  return out;
}

export function validatePermit(s: Store, deps: { auth: BrainAuth }, token: string, invocationId: string): boolean {
  // E046/E055: validation is against *current* authority — a revocation
  // generation bump (quarantine, membership revocation, restore) or a
  // quarantined runner invalidates every previously issued permit.
  const row = s.control.prepare(`SELECT p.expires_at_ms, p.state, p.revocation_generation, p.approval_id,p.subject_digest,c.revoked_at_ms,
      j.organization_id,j.workspace_id,o.revocation_generation AS org_generation, r.admin_state AS runner_state
    FROM permit_credentials c JOIN effect_permits p ON p.id=c.permit_id
    JOIN job_attempts a ON a.id=p.attempt_id
    JOIN runners r ON r.id=a.runner_id
    JOIN jobs j ON j.id=a.job_id AND j.job_fence=a.job_fence AND j.organization_id=r.organization_id
    JOIN workspaces w ON w.id=j.workspace_id AND w.organization_id=j.organization_id AND w.status='active'
    JOIN organizations o ON o.id=r.organization_id
    WHERE c.token_digest=? AND p.invocation_id=? AND a.runner_epoch=r.session_epoch AND a.state='running' AND j.state='running' AND a.lease_expires_at_ms>?`).get(s.tokenDigest("permit", token), invocationId, s.now()) as
    | { expires_at_ms: number; state: string; revocation_generation: number; approval_id: string | null; subject_digest: string; organization_id: string; workspace_id: string; revoked_at_ms: number | null; org_generation: number; runner_state: string } | undefined;
  return !!row && !row.revoked_at_ms && row.state === "issued" && row.expires_at_ms > s.now()
    && row.revocation_generation === row.org_generation
    && row.runner_state !== "quarantined" && row.runner_state !== "disabled"
    && (!row.approval_id || approvalCurrentlyUsable(s, deps.auth, { approvalId: row.approval_id, organizationId: row.organization_id, workspaceId: row.workspace_id, subjectDigest: row.subject_digest }));
}
