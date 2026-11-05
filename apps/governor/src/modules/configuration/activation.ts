import type { ActorContext } from "@brain/contracts";
import type { Store } from "../../application/store";
import { scopesForPrincipal } from "../../application/authz";
import { BrainDomainError } from "../../domain/errors";

/** Configuration changes require a current organization administrator. */
export function requireConfigurationAdmin(store: Store, actor: ActorContext): void {
  if (actor.kind !== "human" || !scopesForPrincipal(store, actor.actorId, actor.organizationId).includes("config:activate")) {
    throw new BrainDomainError("FORBIDDEN", "configuration changes require current organization administration");
  }
}

/**
 * Makes a staged release the active one, re-checking the observed active
 * digest so a concurrent activation fails (compare-and-swap).
 */
export function activateRelease(store: Store, actor: ActorContext, digest: string, expectedActiveDigest?: string | null): void {
  requireConfigurationAdmin(store, actor);
  const s = store;
  s.inTx(s.control, () => {
    const rel = s.control.prepare("SELECT digest FROM config_releases WHERE digest=? AND organization_id=?").get(digest, actor.organizationId);
    if (!rel) throw new BrainDomainError("NOT_FOUND", "config release not found");
    const cur = s.control.prepare("SELECT release_digest, version FROM active_config WHERE organization_id=?").get(actor.organizationId) as
      | { release_digest: string; version: number } | undefined;
    if (expectedActiveDigest !== undefined && (cur?.release_digest ?? null) !== expectedActiveDigest) {
      throw new BrainDomainError("CONFLICT", "active config changed; CAS failed");
    }
    if (cur) s.control.prepare("UPDATE active_config SET release_digest=?, version=version+1 WHERE organization_id=?").run(digest, actor.organizationId);
    else s.control.prepare("INSERT INTO active_config(organization_id, release_digest, version) VALUES (?,?,1)").run(actor.organizationId, digest);
    s.emit(s.control, { organizationId: actor.organizationId, aggregateType: "config", aggregateId: digest, eventType: "config.activated", payload: { digest } });
  });
}
