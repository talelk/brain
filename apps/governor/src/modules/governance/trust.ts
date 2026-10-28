import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";

/**
 * Production trust-domain verification (T28/L2): a human operator with the
 * runner:security scope, acting on a strong (totp-enrolled) session and
 * naming a reason, records that a runner genuinely runs in the named trust
 * domain. Only this Governor-side verifier may set a trust capability to
 * verified — hello claims can never elevate trust (E033), and evaluator
 * independence (L2) requires exactly this verification on both sides.
 */
export function verifyTrustDomain(
  s: Store,
  operator: { actorId: string; organizationId: string; scopes: readonly string[]; kind: string },
  input: { runnerId: string; domain: string; reason: string },
): { capability: string; expiresAtMs: number } {
  if (operator.kind !== "human") throw new BrainDomainError("FORBIDDEN", "trust verification is a human operator action");
  if (!operator.scopes.includes("runner:security")) throw new BrainDomainError("FORBIDDEN", "trust verification requires runner:security");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(input.domain)) throw new BrainDomainError("INVALID_ARGUMENT", "trust domain malformed");
  if (input.reason.trim().length === 0) throw new BrainDomainError("INVALID_ARGUMENT", "a named reason is required");
  const capability = `trust:domain:${input.domain}`;
  let expiresAtMs = 0;
  s.inTx(s.control, () => {
    const runner = s.control.prepare("SELECT organization_id FROM runners WHERE id=?").get(input.runnerId) as { organization_id: string } | undefined;
    if (!runner || runner.organization_id !== operator.organizationId) throw new BrainDomainError("NOT_FOUND", "runner not found");
    expiresAtMs = s.now() + 24 * 3600_000;
    s.control.prepare("INSERT OR REPLACE INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES (?,?,1,?,?,?)")
      .run(input.runnerId, capability, "governor-verifier", s.now(), expiresAtMs);
    s.emit(s.control, {
      organizationId: operator.organizationId, aggregateType: "runner", aggregateId: input.runnerId,
      eventType: "runner.trust.verified", payload: { capability, reason: input.reason.trim(), operatorId: operator.actorId, expiresAtMs },
    });
  });
  return { capability, expiresAtMs };
}

/** Removes a previously verified trust domain (revocation must be possible). */
export function revokeTrustDomain(
  s: Store,
  operator: { actorId: string; organizationId: string; scopes: readonly string[]; kind: string },
  input: { runnerId: string; domain: string; reason: string },
): void {
  if (operator.kind !== "human") throw new BrainDomainError("FORBIDDEN", "trust revocation is a human operator action");
  if (!operator.scopes.includes("runner:security")) throw new BrainDomainError("FORBIDDEN", "trust revocation requires runner:security");
  if (input.reason.trim().length === 0) throw new BrainDomainError("INVALID_ARGUMENT", "a named reason is required");
  s.inTx(s.control, () => {
    const runner = s.control.prepare("SELECT organization_id FROM runners WHERE id=?").get(input.runnerId) as { organization_id: string } | undefined;
    if (!runner || runner.organization_id !== operator.organizationId) throw new BrainDomainError("NOT_FOUND", "runner not found");
    const changed = s.control.prepare("DELETE FROM runner_capabilities WHERE runner_id=? AND capability=? AND source='governor-verifier'")
      .run(input.runnerId, `trust:domain:${input.domain}`);
    if (changed.changes === 0) throw new BrainDomainError("NOT_FOUND", "no verified trust domain to revoke");
    s.emit(s.control, {
      organizationId: operator.organizationId, aggregateType: "runner", aggregateId: input.runnerId,
      eventType: "runner.trust.revoked", payload: { capability: `trust:domain:${input.domain}`, reason: input.reason.trim(), operatorId: operator.actorId },
    });
  });
}
