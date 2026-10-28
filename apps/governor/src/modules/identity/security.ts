import type { Store } from "../../application/store";
import type { ResolvedActor } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";
import type { BrainAuth } from "./auth";

export function assertHumanIdentity(store: Store, auth: BrainAuth, identity: ResolvedActor, requireFactor = false): void {
    const { actor, humanSession } = identity;
    if (actor.kind !== "human" || !humanSession || humanSession.recoveryRequired || (requireFactor && !humanSession.factorDigest)) throw new BrainDomainError("FORBIDDEN", requireFactor ? "verified human session and enrolled TOTP required" : "current verified human session required");
    const row = store.control.prepare("SELECT p.auth_subject_id,p.disabled_at_ms,o.auth_organization_id,o.revocation_generation FROM principals p JOIN organizations o ON o.id=p.organization_id WHERE p.id=? AND p.organization_id=? AND p.kind='human'").get(actor.actorId, actor.organizationId) as { auth_subject_id: string; disabled_at_ms: number | null; auth_organization_id: string; revocation_generation: number } | undefined;
    if (!row || row.disabled_at_ms !== null || row.auth_subject_id !== humanSession.userId || row.revocation_generation !== actor.authGeneration || identity.sessionDigest !== store.tokenDigest("auth-session", humanSession.sessionId) || !auth.hasMembership(humanSession.userId, row.auth_organization_id) || !auth.isSessionCurrent(humanSession.userId, humanSession.sessionId, store.now(), requireFactor ? humanSession.factorDigest : undefined)) throw new BrainDomainError("UNAUTHENTICATED", "human session, membership or factor changed; authenticate again");
}
