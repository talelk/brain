import { randomBytes, verify } from "node:crypto";
import type { JsonValue } from "@brain/contracts";
import { domainDigest } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { iso } from "../../domain/clock";
import type { Store } from "../../application/store";

/**
 * Runner identity and session protocol (enrollment, challenge/hello, epoch
 * fencing, heartbeats). Private files; the public surface is the module index.
 */
export function issueEnrollment(s: Store, actor: { scopes: readonly string[]; actorId: string; organizationId: string }, groupId: string): { token: string; expiresAt: string } {
  if (!actor.scopes.includes("runner:admin")) throw new BrainDomainError("FORBIDDEN", "runner enrollment requires runner:admin");
  const token = randomBytes(32).toString("base64url");
  const expires = s.now() + 10 * 60_000;
  s.control.prepare("INSERT INTO enrollment_tokens(token_digest, organization_id, group_id, expires_at_ms, created_by) VALUES (?,?,?,?,?)")
    .run(s.tokenDigest("enroll", token), actor.organizationId, groupId, expires, actor.actorId);
  return { token, expiresAt: iso(expires) };
}

export function enrollRunner(s: Store, input: { token: string; publicKeyPem: string; runnerId: string }): { credential: string } {
  if (!input.publicKeyPem.includes("BEGIN PUBLIC KEY")) throw new BrainDomainError("INVALID_ARGUMENT", "Ed25519 SPKI PEM required");
  const credential = randomBytes(32).toString("base64url");
  s.inTx(s.control, () => {
    const row = s.control.prepare("SELECT organization_id, group_id, expires_at_ms, consumed_at_ms FROM enrollment_tokens WHERE token_digest=?")
      .get(s.tokenDigest("enroll", input.token)) as { organization_id: string; group_id: string; expires_at_ms: number; consumed_at_ms: number | null } | undefined;
    if (!row || row.consumed_at_ms || row.expires_at_ms <= s.now()) throw new BrainDomainError("FORBIDDEN", "enrollment token invalid, expired, or replayed");
    s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
      VALUES (?,?,?,?,'enabled','healthy','sha256:${"0".repeat(64)}',0,0,0,1)`)
      .run(input.runnerId, row.organization_id, row.group_id, s.tokenDigest("pubkey", input.publicKeyPem));
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

export function heartbeat(s: Store, runner: { runnerId: string; epoch: number }, body: Record<string, unknown>): { acceptedSequence: number } {
  const seq = Number(body["sequence"] ?? 0);
  const digest = domainDigest("brain:heartbeat:v1", body as unknown as JsonValue);
  s.inTx(s.control, () => {
    const row = s.control.prepare("SELECT session_epoch, heartbeat_seq, heartbeat_digest FROM runners WHERE id=?").get(runner.runnerId) as
      | { session_epoch: number; heartbeat_seq: number; heartbeat_digest: string | null } | undefined;
    if (!row || row.session_epoch !== runner.epoch) throw new BrainDomainError("LEASE_LOST", "runner epoch fenced");
    if (seq === row.heartbeat_seq && row.heartbeat_digest === digest) return;
    if (seq <= row.heartbeat_seq) throw new BrainDomainError("CONFLICT", "heartbeat sequence regression or changed payload");
    s.control.prepare("UPDATE runners SET heartbeat_seq=?, heartbeat_digest=?, last_heartbeat_ms=? WHERE id=?").run(seq, digest, s.now(), runner.runnerId);
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
  return { acceptedSequence: seq };
}
