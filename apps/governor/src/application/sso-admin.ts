import type { ActorContext, JsonValue } from "@brain/contracts";
import { BrainDomainError } from "../domain/errors";
import { checkIssuer, OIDC_ROLES, oidcView, readOidcSettings, resolveSecretRef, saveOidcSettings, type OidcRole, type OidcSettings } from "../modules/identity/oidc";
import type { CommandHandlers } from "./command-funnel";
import type { Store } from "./store";

/**
 * Administration of single sign-on (ADR 0026): `identity.oidc.set` stores the provider, its secret reference and how new people are
 * provisioned; `identity.oidc.get` shows the setting without the secret. The provider is registered with the sign-in vendor after the
 * command commits (see Brain's afterCommit), so a change takes effect without a restart.
 */
export function ssoCommands(store: Store): CommandHandlers {
  const s = store;
  return {
    "identity.oidc.set": {
      kind: "control",
      handle: ({ actor, cmd }) => {
        if (actor.kind !== "human" || !actor.scopes.includes("identity:security")) throw new BrainDomainError("FORBIDDEN", "single sign-on is set by an identity security administrator");
        const p = cmd.payload;
        const prior = readOidcSettings(s.control);
        if (prior && prior.organizationId !== actor.organizationId) throw new BrainDomainError("CONFLICT", "single sign-on already belongs to another organization on this Governor");
        const enabled = p["enabled"] === true;
        const issuer = checkIssuer(String(p["issuer"]));
        const secretRef = String(p["secretRef"]);
        // An enabled provider must be usable now: its secret has to resolve. A disabled one may be saved half-prepared.
        if (enabled) resolveSecretRef(secretRef);
        const workspaceIds = [...new Set((p["workspaceIds"] as string[] | undefined) ?? [])].sort();
        for (const id of workspaceIds) if (!s.control.prepare("SELECT 1 FROM workspaces WHERE id=? AND organization_id=?").get(id, actor.organizationId)) throw new BrainDomainError("NOT_FOUND", `workspace ${id} not found`);
        const groupRoles = ((p["groupRoles"] as Array<{ group: string; role: OidcRole }> | undefined) ?? []).map((entry) => ({ group: entry.group, role: entry.role }));
        for (const entry of groupRoles) if (!OIDC_ROLES.includes(entry.role)) throw new BrainDomainError("INVALID_ARGUMENT", `role ${entry.role} cannot be given by single sign-on`);
        const autoProvision = p["autoProvision"] === true;
        const defaultRole = (p["defaultRole"] as OidcRole | undefined) ?? null;
        if (enabled && autoProvision && !defaultRole && groupRoles.length === 0) throw new BrainDomainError("INVALID_ARGUMENT", "Automatic provisioning needs a default role or at least one group mapping");
        const settings: OidcSettings = {
          organizationId: actor.organizationId, enabled, issuer, clientId: String(p["clientId"]), secretRef, autoProvision, defaultRole,
          groupClaim: typeof p["groupClaim"] === "string" ? p["groupClaim"] : "groups", groupRoles, workspaceIds,
          allowedDomains: [...new Set(((p["allowedDomains"] as string[] | undefined) ?? []).map((d) => d.toLowerCase()))].sort(), updatedBy: actor.actorId, updatedAtMs: s.now(),
        };
        saveOidcSettings(s.control, settings);
        s.emit(s.control, { organizationId: actor.organizationId, aggregateType: "platform", aggregateId: "identity-provider", eventType: "identity.oidcSet",
          payload: { enabled, issuer, clientId: settings.clientId, autoProvision, defaultRole, groupRoles: groupRoles.length, workspaceIds } });
        return { resourceId: "identity-provider" };
      },
    },
  };
}

/** identity.oidc.get: the single sign-on setting, with the redirect address to register at the directory. Never the secret. */
export function oidcSettingsQuery(store: Store, actor: ActorContext, baseUrl: string): JsonValue {
  if (actor.kind !== "human" || !actor.scopes.includes("identity:read")) throw new BrainDomainError("FORBIDDEN", "identity administration read scope required");
  const settings = readOidcSettings(store.control);
  return oidcView(settings && settings.organizationId === actor.organizationId ? settings : undefined, baseUrl) as unknown as JsonValue;
}
