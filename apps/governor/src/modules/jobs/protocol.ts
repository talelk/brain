import { randomBytes, verify } from "node:crypto";
import type { JsonValue } from "@brain/contracts";
import { domainDigest } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import type { Store } from "../../application/store";
import { drainSessionControls, type LiveAttempt, type SessionControlDelivery } from "../sessions/index";

/**
 * Runner identity and session protocol (enrollment, challenge/hello, epoch
 * fencing, heartbeats). Private files; the public surface is the module index.
 */
export function issueEnrollment(s: Store, actor: { scopes: readonly string[]; actorId: string; organizationId: string }, groupId: string): { token: string; expiresAt: string } {
  if (!actor.scopes.includes("runner:admin")) throw new BrainDomainError("FORBIDDEN", "runner enrollment requires runner:admin");
  const release = s.control.prepare("SELECT r.manifest_json FROM active_config a JOIN config_releases r ON r.digest=a.release_digest WHERE a.organization_id=?").get(actor.organizationId) as { manifest_json: string } | undefined;
  const documents = release ? (JSON.parse(release.manifest_json) as { manifest?: { documents?: Array<{ kind?: string; id?: string }> } }).manifest?.documents ?? [] : [];
  if (!documents.some((document) => document.kind === "RunnerGroup" && document.id === groupId)) throw new BrainDomainError("NOT_FOUND", `runner group ${groupId} is not declared in the active release`);
  const token = randomBytes(32).toString("base64url");
  const expires = s.now() + 10 * 60_000;
  s.control.prepare("INSERT INTO enrollment_tokens(token_digest, organization_id, group_id, expires_at_ms, created_by) VALUES (?,?,?,?,?)")
    .run(s.tokenDigest("enroll", token), actor.organizationId, groupId, expires, actor.actorId);
  return { token, expiresAt: iso(expires) };
}

export function operateRunner(s: Store, actor: { scopes: readonly string[]; actorId: string; organizationId: string }, input: { runnerId: string; action: string; reason: string }): string {
  if (!actor.scopes.includes("runner:admin")) throw new BrainDomainError("FORBIDDEN", "runner administration requires runner:admin");
  if (!input.reason.trim()) throw new BrainDomainError("INVALID_ARGUMENT", "runner operations require a reason");
  const runner = s.control.prepare("SELECT admin_state,health,last_heartbeat_ms,deregistered_at_ms FROM runners WHERE id=? AND organization_id=?").get(input.runnerId, actor.organizationId) as
    | { admin_state: string; health: string; last_heartbeat_ms: number | null; deregistered_at_ms: number | null } | undefined;
  if (!runner) throw new BrainDomainError("NOT_FOUND", "runner not found");
  if (runner.deregistered_at_ms) throw new BrainDomainError("CONFLICT", "runner is already deregistered");
  if (runner.admin_state === "quarantined" && input.action === "enable" && !actor.scopes.includes("runner:security")) {
    throw new BrainDomainError("FORBIDDEN", "re-enabling a quarantined runner requires runner:security");
  }
  if (input.action === "quarantine" && !actor.scopes.includes("runner:security")) {
    throw new BrainDomainError("FORBIDDEN", "quarantining a runner requires runner:security");
  }
  const active = s.control.prepare("SELECT COUNT(*) AS count FROM job_attempts WHERE runner_id=? AND state IN ('offered','running','uploading','cancelling','verifying','outcome_unknown')").get(input.runnerId) as { count: number };
  if ((input.action === "rotate" || input.action === "deregister") && active.count > 0) throw new BrainDomainError("CONFLICT", "runner still has active or unresolved attempts");
  s.inTx(s.control, () => {
    const now = s.now();
    if (input.action === "enable") {
      const capability = s.control.prepare("SELECT 1 AS ok FROM runner_capabilities WHERE runner_id=? AND verified=1 AND expires_at_ms>? LIMIT 1").get(input.runnerId, now);
      if (runner.health === "unhealthy" || Number(runner.last_heartbeat_ms ?? 0) <= now - 45_000 || !capability) {
        throw new BrainDomainError("CONFLICT", "runner needs a current heartbeat, non-unhealthy status and a fresh verified capability before enable");
      }
      s.control.prepare("UPDATE runners SET admin_state='enabled' WHERE id=?").run(input.runnerId);
    } else if (input.action === "disable") {
      s.control.prepare("UPDATE runners SET admin_state='disabled' WHERE id=?").run(input.runnerId);
    } else if (input.action === "drain") {
      // E045: a draining runner takes no new claims but finishes owned work.
      s.control.prepare("UPDATE runners SET admin_state='draining' WHERE id=?").run(input.runnerId);
    } else if (input.action === "quarantine") {
      // E046: quarantine revokes the runner's sessions and every issued permit.
      s.control.prepare("UPDATE runners SET admin_state='quarantined' WHERE id=?").run(input.runnerId);
      s.control.prepare("UPDATE runner_sessions SET revoked_at_ms=? WHERE runner_id=? AND revoked_at_ms IS NULL").run(now, input.runnerId);
      s.control.prepare("UPDATE organizations SET revocation_generation=revocation_generation+1 WHERE id=?").run(actor.organizationId);
    } else if (input.action === "rotate" || input.action === "deregister") {
      s.control.prepare("UPDATE runners SET admin_state='disabled',session_epoch=session_epoch+1,boot_nonce=NULL,deregistered_at_ms=CASE WHEN ?='deregister' THEN ? ELSE deregistered_at_ms END WHERE id=?")
        .run(input.action, now, input.runnerId);
      s.control.prepare("UPDATE runner_sessions SET revoked_at_ms=? WHERE runner_id=? AND revoked_at_ms IS NULL").run(now, input.runnerId);
      s.control.prepare("UPDATE runner_identity_credentials SET revoked_at_ms=? WHERE runner_id=? AND revoked_at_ms IS NULL").run(now, input.runnerId);
      if (input.action === "deregister") s.control.prepare("DELETE FROM runner_capabilities WHERE runner_id=?").run(input.runnerId);
      s.control.prepare("UPDATE organizations SET revocation_generation=revocation_generation+1 WHERE id=?").run(actor.organizationId);
    } else {
      throw new BrainDomainError("INVALID_ARGUMENT", "runner action must be enable, disable, drain, quarantine, rotate or deregister");
    }
    const eventType = input.action === "drain" ? "runner.draining" : input.action === "quarantine" ? "runner.quarantined" : `runner.${input.action}d`;
    s.emit(s.control, { organizationId: actor.organizationId, aggregateType: "runner", aggregateId: input.runnerId, eventType, payload: { runnerId: input.runnerId, reason: input.reason, actorId: actor.actorId } });
  });
  return input.runnerId;
}

export function enrollRunner(s: Store, input: { token: string; publicKeyPem: string; runnerId: string }): { credential: string } {
  if (!input.publicKeyPem.includes("BEGIN PUBLIC KEY")) throw new BrainDomainError("INVALID_ARGUMENT", "Ed25519 SPKI PEM required");
  const credential = randomBytes(32).toString("base64url");
  s.inTx(s.control, () => {
    const row = s.control.prepare("SELECT organization_id, group_id, expires_at_ms, consumed_at_ms FROM enrollment_tokens WHERE token_digest=?")
      .get(s.tokenDigest("enroll", input.token)) as { organization_id: string; group_id: string; expires_at_ms: number; consumed_at_ms: number | null } | undefined;
    if (!row || row.consumed_at_ms || row.expires_at_ms <= s.now()) throw new BrainDomainError("FORBIDDEN", "enrollment token invalid, expired, or replayed");
    const existing = s.control.prepare("SELECT organization_id,admin_state,deregistered_at_ms FROM runners WHERE id=?").get(input.runnerId) as { organization_id: string; admin_state: string; deregistered_at_ms: number | null } | undefined;
    if (existing && (existing.organization_id !== row.organization_id || existing.admin_state !== "disabled" || existing.deregistered_at_ms)) {
      throw new BrainDomainError("CONFLICT", "runner identity already exists; rotate a disabled runner before re-enrollment");
    }
    if (existing) {
      s.control.prepare("UPDATE runners SET group_id=?,identity_key_digest=?,session_epoch=session_epoch+1,boot_nonce=NULL,last_heartbeat_ms=NULL,config_digest=? WHERE id=?")
        .run(row.group_id, s.tokenDigest("pubkey", input.publicKeyPem), `sha256:${"0".repeat(64)}`, input.runnerId);
      s.control.prepare("DELETE FROM runner_identity_credentials WHERE runner_id=?").run(input.runnerId);
    } else {
      s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
        VALUES (?,?,?,?,'enabled','healthy','sha256:${"0".repeat(64)}',0,0,0,1)`)
        .run(input.runnerId, row.organization_id, row.group_id, s.tokenDigest("pubkey", input.publicKeyPem));
    }
    s.control.prepare("INSERT INTO runner_identity_credentials(runner_id, public_key_spki_pem, credential_digest, expires_at_ms) VALUES (?,?,?,?)")
      .run(input.runnerId, input.publicKeyPem, s.tokenDigest("runner-cred", credential), s.now() + 365 * 24 * 3600_000);
    s.control.prepare("UPDATE enrollment_tokens SET consumed_at_ms=?, runner_id=? WHERE token_digest=?").run(s.now(), input.runnerId, s.tokenDigest("enroll", input.token));
  });
  return { credential };
}

export function runnerChallenge(s: Store, runnerId: string, credential: string): { challengeId: string; nonce: string; expiresAt: string } {
  const row = s.control.prepare("SELECT credential_digest, expires_at_ms, revoked_at_ms FROM runner_identity_credentials WHERE runner_id=?").get(runnerId) as
    | { credential_digest: string; expires_at_ms: number; revoked_at_ms: number | null } | undefined;
  if (!row || row.revoked_at_ms || row.expires_at_ms <= s.now() || row.credential_digest !== s.tokenDigest("runner-cred", credential)) {
    throw new BrainDomainError("UNAUTHENTICATED", "runner credential invalid");
  }
  const challengeId = s.id("chal");
  const nonce = randomBytes(32).toString("base64url");
  const expires = s.now() + 60_000;
  s.control.prepare("INSERT INTO runner_challenges(id, runner_id, nonce, expires_at_ms) VALUES (?,?,?,?)").run(challengeId, runnerId, nonce, expires);
  return { challengeId, nonce, expiresAt: iso(expires) };
}

export function runnerHello(s: Store, hello: Record<string, unknown>): { sessionToken: string; epoch: number; serverTime: string } {
  // E100: mismatched runner protocol is refused with diagnostics; no
  // cross-version normalization or upgrade path is attempted.
  if (hello["contractVersion"] !== "brain.runner/v1") {
    throw new BrainDomainError("UNSUPPORTED_PROTOCOL", `runner contract ${String(hello["contractVersion"] ?? "absent")} unsupported; expected brain.runner/v1`);
  }
  const runnerId = String(hello["runnerId"]);
  const proof = hello["proof"] as { challengeId: string; signatureBase64url: string };
  let epoch = 0;
  let sessionToken = "";
  s.inTx(s.control, () => {
    const cred = s.control.prepare("SELECT public_key_spki_pem FROM runner_identity_credentials WHERE runner_id=? AND revoked_at_ms IS NULL").get(runnerId) as { public_key_spki_pem: string } | undefined;
    if (!cred) throw new BrainDomainError("UNAUTHENTICATED", "runner not enrolled");
    const chal = s.control.prepare("SELECT nonce, expires_at_ms, consumed_at_ms FROM runner_challenges WHERE id=? AND runner_id=?").get(proof.challengeId, runnerId) as
      | { nonce: string; expires_at_ms: number; consumed_at_ms: number | null } | undefined;
    if (!chal || chal.consumed_at_ms || chal.expires_at_ms <= s.now()) throw new BrainDomainError("UNAUTHENTICATED", "challenge invalid or replayed");
    const rest = Object.fromEntries(Object.entries(hello).filter(([k]) => k !== "proof"));
    const helloDigest = domainDigest("brain:runner-hello:v1", rest as unknown as JsonValue);
    const signed = JSON.stringify({ challengeId: proof.challengeId, nonce: chal.nonce, runnerId, bootNonce: hello["bootNonce"], helloDigest });
    let ok = false;
    try {
      ok = verify(null, Buffer.from(signed, "utf8"), cred.public_key_spki_pem, Buffer.from(proof.signatureBase64url, "base64url"));
    } catch { ok = false; }
    if (!ok) throw new BrainDomainError("UNAUTHENTICATED", "hello proof verification failed");
    s.control.prepare("UPDATE runner_challenges SET consumed_at_ms=? WHERE id=?").run(s.now(), proof.challengeId);
    const runner = s.control.prepare("SELECT session_epoch, boot_nonce, admin_state FROM runners WHERE id=?").get(runnerId) as { session_epoch: number; boot_nonce: string | null; admin_state: string } | undefined;
    if (!runner) throw new BrainDomainError("UNAUTHENTICATED", "runner missing");
    if (runner.admin_state === "quarantined" || runner.admin_state === "disabled") throw new BrainDomainError("FORBIDDEN", "runner is quarantined/disabled");
    if (runner.boot_nonce === String(hello["bootNonce"]) && runner.session_epoch > 0) {
      epoch = runner.session_epoch;
    } else {
      epoch = runner.session_epoch + 1;
      s.control.prepare("UPDATE runner_sessions SET revoked_at_ms=? WHERE runner_id=? AND revoked_at_ms IS NULL").run(s.now(), runnerId);
    }
    const capacity = hello["capacity"] as { cpuMillicores: number; memoryMb: number; diskMb: number; slots: number };
    s.control.prepare(`UPDATE runners SET session_epoch=?, boot_nonce=?, last_heartbeat_ms=?, heartbeat_seq=0, config_digest=?,
      cpu_capacity=?, memory_capacity=?, disk_capacity=?, slot_capacity=? WHERE id=?`)
      .run(epoch, String(hello["bootNonce"]), s.now(), String(hello["configDigest"]), capacity?.cpuMillicores ?? 0, capacity?.memoryMb ?? 0, capacity?.diskMb ?? 0, Math.max(1, capacity?.slots ?? 1), runnerId);
    s.control.prepare("DELETE FROM runner_capabilities WHERE runner_id=?").run(runnerId);
    for (const cap of (hello["capabilities"] as Array<Record<string, unknown>> | undefined) ?? []) {
      const capability = String(cap["capability"]);
      // E033: a hello can never elevate registered trust. Privileged/target
      // capabilities are stored unverified regardless of self-assertion;
      // only a Governor-side verifier may mark them verified. The runner's
      // group likewise comes from enrollment, never from the hello body.
      const privilegedClaim = /^(privileged|admin|target|group|trust):/i.test(capability);
      s.control.prepare("INSERT OR REPLACE INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?,?,?,?,?,?)")
        .run(runnerId, capability, privilegedClaim ? 0 : cap["verified"] ? 1 : 0, String(cap["source"] ?? "hello"), s.now(), s.now() + 5 * 60_000);
    }
    sessionToken = randomBytes(32).toString("base64url");
    s.control.prepare("INSERT INTO runner_sessions(token_digest, runner_id, runner_epoch, expires_at_ms, created_at_ms) VALUES (?,?,?,?,?) ON CONFLICT(runner_id, runner_epoch) DO UPDATE SET token_digest=excluded.token_digest, expires_at_ms=excluded.expires_at_ms, revoked_at_ms=NULL")
      .run(s.tokenDigest("runner-session", sessionToken), runnerId, epoch, s.now() + 15 * 60_000, s.now());
  });
  return { sessionToken, epoch, serverTime: s.nowIso() };
}

export function authRunner(s: Store, headers: Headers): { runnerId: string; epoch: number; organizationId: string } {
  if (headers.has("cookie")) throw new BrainDomainError("UNAUTHENTICATED", "browser cookies rejected on runner endpoints");
  const auth = headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new BrainDomainError("UNAUTHENTICATED", "runner session required");
  const row = s.control.prepare(`SELECT rs.runner_id, rs.runner_epoch, rs.expires_at_ms, rs.revoked_at_ms, r.organization_id, r.session_epoch
    FROM runner_sessions rs JOIN runners r ON r.id=rs.runner_id WHERE rs.token_digest=?`).get(s.tokenDigest("runner-session", token)) as
    | { runner_id: string; runner_epoch: number; expires_at_ms: number; revoked_at_ms: number | null; organization_id: string; session_epoch: number } | undefined;
  if (!row || row.revoked_at_ms || row.expires_at_ms <= s.now() || row.runner_epoch !== row.session_epoch) {
    throw new BrainDomainError("UNAUTHENTICATED", "runner session stale or revoked");
  }
  return { runnerId: row.runner_id, epoch: row.runner_epoch, organizationId: row.organization_id };
}

/** A command handed to the runner in the heartbeat ack (sessions module). */
export type HeartbeatCommand = SessionControlDelivery;

const MAX_HEARTBEAT_COMMANDS = 100;
const MAX_DRAIN_ATTEMPTS = 10;

/** The runner's live attempts (hard cap), whose sessions' controls ride the heartbeat ack. */
function drainForRunner(s: Store, runner: { runnerId: string; epoch: number }): HeartbeatCommand[] {
  const attempts = s.control.prepare(`SELECT a.id AS attemptId, j.workspace_id AS workspaceId, j.organization_id AS organizationId
    FROM job_attempts a JOIN jobs j ON j.id=a.job_id
    WHERE a.runner_id=? AND a.runner_epoch=? AND a.state IN ('offered','running','uploading','cancelling')
    ORDER BY a.id LIMIT ?`).all(runner.runnerId, runner.epoch, MAX_DRAIN_ATTEMPTS) as LiveAttempt[];
  return drainSessionControls(s, attempts, MAX_HEARTBEAT_COMMANDS);
}

export function heartbeat(s: Store, runner: { runnerId: string; epoch: number }, body: Record<string, unknown>): { acceptedSequence: number; serverTime: string; commands: HeartbeatCommand[] } {
  const seq = Number(body["sequence"] ?? 0);
  const digest = domainDigest("brain:heartbeat:v1", body as unknown as JsonValue);
  s.inTx(s.control, () => {
    const row = s.control.prepare("SELECT session_epoch, heartbeat_seq, heartbeat_digest FROM runners WHERE id=?").get(runner.runnerId) as
      | { session_epoch: number; heartbeat_seq: number; heartbeat_digest: string | null } | undefined;
    if (!row || row.session_epoch !== runner.epoch) throw new BrainDomainError("LEASE_LOST", "runner epoch fenced");
    if (seq === row.heartbeat_seq && row.heartbeat_digest === digest) return;
    if (seq <= row.heartbeat_seq) throw new BrainDomainError("CONFLICT", "heartbeat sequence regression or changed payload");
    const health = body["health"];
    if (health === "healthy" || health === "degraded" || health === "unhealthy") {
      s.control.prepare("UPDATE runners SET heartbeat_seq=?, heartbeat_digest=?, last_heartbeat_ms=?, health=? WHERE id=?").run(seq, digest, s.now(), health, runner.runnerId);
    } else {
      s.control.prepare("UPDATE runners SET heartbeat_seq=?, heartbeat_digest=?, last_heartbeat_ms=? WHERE id=?").run(seq, digest, s.now(), runner.runnerId);
    }
    if (Array.isArray(body["capabilities"])) {
      if (body["capabilities"].length > 128) throw new BrainDomainError("INVALID_CONTRACT", "too many capability observations");
      s.control.prepare("DELETE FROM runner_capabilities WHERE runner_id=? AND source='runner-probe'").run(runner.runnerId);
      for (const raw of body["capabilities"]) {
        const cap = raw as { capability?: unknown; verified?: unknown };
        if (typeof cap.capability !== "string" || !/^[a-zA-Z0-9:._-]{1,128}$/u.test(cap.capability)) throw new BrainDomainError("INVALID_CONTRACT", "invalid capability observation");
        if (/^(privileged|admin|target|group|trust):/iu.test(cap.capability)) continue;
        s.control.prepare("INSERT OR REPLACE INTO runner_capabilities(runner_id,capability,verified,source,observed_at_ms,expires_at_ms) VALUES (?,?,?,'runner-probe',?,?)").run(runner.runnerId,cap.capability,cap.verified === true ? 1 : 0,s.now(),s.now()+300000);
      }
    }
  });
  const commands = drainForRunner(s, runner);
  return { acceptedSequence: seq, serverTime: s.nowIso(), commands };
}
