import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { setupWorld, seedHuman } from "../helpers";

// T28/L2 production verifier: only a human operator with the security-admin
// role (runner:security) may record a verified trust domain on a same-org
// runner, with a named reason and an audit event; revocation removes exactly
// that record. Hello claims and test attestations remain unable to elevate
// trust (E033).
describe("trust-domain verifier (T28/L2)", () => {
  it("verifies, audits and revokes a runner trust domain behind runner:security", async () => {
    const w = await setupWorld();
    const { brain } = w;
    const securitySession = seedHuman(brain, w.org, "sec-op");
    brain.store.control.prepare("INSERT OR REPLACE INTO organization_authorizations(organization_id, principal_id, role, granted_by, granted_at_ms) VALUES (?, 'sec-op', 'security-admin', 'owner-1', ?)")
      .run(w.org, brain.store.now());
    const owner = w.actor("owner-1");
    const { token } = brain.issueEnrollment(owner, "fixture");
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    brain.enrollRunner({ token, publicKeyPem, runnerId: "runner-trust-1" });
    const runnerId = "runner-trust-1";
    const operator = await brain.resolveActor(new Headers({ authorization: `Bearer ${securitySession.token}` }));
    expect(operator.actor.scopes).toContain("runner:security");

    // Without the role the same call is refused before anything is written.
    const plainSession = seedHuman(brain, w.org, "owner-no-role");
    const plain = await brain.resolveActor(new Headers({ authorization: `Bearer ${plainSession.token}` }));
    expect(() => brain.verifyTrustDomain(plain, { runnerId, domain: "prod-host-1", reason: "x" })).toThrow(/runner:security/);
    // Empty reason is refused.
    expect(() => brain.verifyTrustDomain(operator, { runnerId, domain: "prod-host-1", reason: "  " })).toThrow(/reason/);

    const result = brain.verifyTrustDomain(operator, { runnerId, domain: "prod-host-1", reason: "provisioned host attested by platform team" });
    expect(result.capability).toBe("trust:domain:prod-host-1");
    const cap = brain.store.control.prepare("SELECT verified, source FROM runner_capabilities WHERE runner_id=? AND capability=?").get(runnerId, "trust:domain:prod-host-1") as { verified: number; source: string };
    expect(cap.verified).toBe(1);
    expect(cap.source).toBe("governor-verifier");

    const audit = brain.store.control.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='runner.trust.verified'").get() as { n: number } | undefined;
    expect(audit?.n ?? 0).toBeGreaterThanOrEqual(1);

    brain.revokeTrustDomain(operator.actor, { runnerId, domain: "prod-host-1", reason: "host decommissioned" });
    const remaining = brain.store.control.prepare("SELECT COUNT(*) AS n FROM runner_capabilities WHERE runner_id=? AND capability=?").get(runnerId, "trust:domain:prod-host-1") as { n: number } | undefined;
    expect(remaining?.n ?? 0).toBe(0);
  });
});
