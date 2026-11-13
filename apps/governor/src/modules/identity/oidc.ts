import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Db } from "../../infrastructure/persistence/open";
import { BrainDomainError } from "../../domain/errors";

/**
 * Single sign-on with the company directory (OpenID Connect, authorization code with PKCE) as an identity provider option set in
 * Administration (ADR 0026). Password and authenticator sign-in stay. One provider per Governor, owned by one organization.
 *
 * The client secret is never stored or shown: the setting holds a reference (`file:/abs/path` of an owner-only file, or `env:NAME`)
 * that is resolved when the provider is registered. A new person is created on first sign-in only when the setting says so, with the
 * workspace roles the setting maps (a group claim, else the default role); a person that matches nothing is refused before any
 * account exists. Roles an administrator set later are never overwritten by a later sign-in.
 */
export const OIDC_PROVIDER_ID = "brain-oidc";
export const OIDC_ROLES = ["viewer", "operator", "workspace-lead", "approver"] as const;
export type OidcRole = (typeof OIDC_ROLES)[number];

export interface OidcSettings {
  readonly organizationId: string;
  readonly enabled: boolean;
  readonly issuer: string;
  readonly clientId: string;
  readonly secretRef: string;
  readonly autoProvision: boolean;
  readonly defaultRole: OidcRole | null;
  readonly groupClaim: string;
  readonly groupRoles: ReadonlyArray<{ readonly group: string; readonly role: OidcRole }>;
  /** Workspaces a new person joins; empty means every active workspace of the organization at the time of first sign-in. */
  readonly workspaceIds: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly updatedBy: string;
  readonly updatedAtMs: number;
}

interface Row {
  organization_id: string; enabled: number; issuer: string; client_id: string; secret_ref: string; auto_provision: number; default_role: OidcRole | null;
  group_claim: string; group_roles_json: string; workspace_ids_json: string; allowed_domains_json: string; updated_by: string; updated_at_ms: number;
}

export function readOidcSettings(db: Db): OidcSettings | undefined {
  const row = db.prepare("SELECT * FROM identity_provider WHERE singleton=1").get() as Row | undefined;
  if (!row) return undefined;
  return {
    organizationId: row.organization_id, enabled: row.enabled === 1, issuer: row.issuer, clientId: row.client_id, secretRef: row.secret_ref, autoProvision: row.auto_provision === 1,
    defaultRole: row.default_role, groupClaim: row.group_claim, groupRoles: JSON.parse(row.group_roles_json) as OidcSettings["groupRoles"],
    workspaceIds: JSON.parse(row.workspace_ids_json) as string[], allowedDomains: JSON.parse(row.allowed_domains_json) as string[], updatedBy: row.updated_by, updatedAtMs: row.updated_at_ms,
  };
}

export function saveOidcSettings(db: Db, settings: OidcSettings): void {
  db.prepare(`INSERT INTO identity_provider(singleton,organization_id,enabled,issuer,client_id,secret_ref,auto_provision,default_role,group_claim,group_roles_json,workspace_ids_json,allowed_domains_json,updated_by,updated_at_ms)
    VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET organization_id=excluded.organization_id,enabled=excluded.enabled,issuer=excluded.issuer,client_id=excluded.client_id,secret_ref=excluded.secret_ref,auto_provision=excluded.auto_provision,
      default_role=excluded.default_role,group_claim=excluded.group_claim,group_roles_json=excluded.group_roles_json,workspace_ids_json=excluded.workspace_ids_json,allowed_domains_json=excluded.allowed_domains_json,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`)
    .run(settings.organizationId, settings.enabled ? 1 : 0, settings.issuer, settings.clientId, settings.secretRef, settings.autoProvision ? 1 : 0, settings.defaultRole, settings.groupClaim,
      JSON.stringify(settings.groupRoles), JSON.stringify(settings.workspaceIds), JSON.stringify(settings.allowedDomains), settings.updatedBy, settings.updatedAtMs);
}

/** The issuer must be https; http is allowed only for a loopback development provider. Returns the issuer without a trailing slash. */
export function checkIssuer(issuer: string): string {
  let url: URL;
  try { url = new URL(issuer); } catch { throw new BrainDomainError("INVALID_ARGUMENT", "The issuer must be an absolute URL"); }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new BrainDomainError("INVALID_ARGUMENT", "The issuer must be https (http is allowed only for a localhost provider)");
  if (url.username || url.password || url.search || url.hash) throw new BrainDomainError("INVALID_ARGUMENT", "The issuer must not carry credentials, a query or a fragment");
  return issuer.replace(/\/+$/u, "");
}

/**
 * Reads the client secret a reference points at. `file:` must be an owner-only regular file, `env:` a variable of the Governor process;
 * either must hold at least 8 characters. The value is returned to the caller that registers the provider and goes nowhere else.
 */
export function resolveSecretRef(ref: string, env: NodeJS.ProcessEnv = process.env): string {
  let value: string;
  if (ref.startsWith("file:")) {
    const path = ref.slice(5);
    if (!path.startsWith("/") || !existsSync(path)) throw new BrainDomainError("INVALID_ARGUMENT", "The secret file does not exist on the server");
    const st = statSync(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0) throw new BrainDomainError("INVALID_ARGUMENT", "The secret file must be a regular file with no group or other permissions");
    value = readFileSync(path, "utf8").trim();
  } else if (ref.startsWith("env:")) {
    value = (env[ref.slice(4)] ?? "").trim();
  } else throw new BrainDomainError("INVALID_ARGUMENT", "The secret reference must start with file:/ or env:");
  if (value.length < 8) throw new BrainDomainError("INVALID_ARGUMENT", "The secret behind the reference is missing or too short");
  return value;
}

const claimAt = (profile: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), profile);
/** The groups a profile asserts: an array, or one string split on commas and spaces. A claim literally named like the path wins over a nested lookup. */
export function groupsOf(profile: Record<string, unknown>, claim: string): string[] {
  const raw = profile[claim] ?? claimAt(profile, claim);
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/u) : [];
  return [...new Set(list.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
}

export type Decision = { readonly allowed: true; readonly roles: readonly OidcRole[]; readonly workspaceIds: readonly string[] } | { readonly allowed: false; readonly reason: string };

/** Whether this directory identity may be given a new account, and what it gets. Pure apart from reading the organization's active workspaces. */
export function decideProvision(db: Db, settings: OidcSettings, profile: Record<string, unknown>): Decision {
  if (!settings.enabled) return { allowed: false, reason: "sso_disabled" };
  if (!settings.autoProvision) return { allowed: false, reason: "not_a_member" };
  const email = typeof profile["email"] === "string" ? profile["email"].toLowerCase() : "";
  if (!email || profile["email_verified"] !== true) return { allowed: false, reason: "email_not_verified" };
  if (!domainAllowed(settings, email)) return { allowed: false, reason: "domain_not_allowed" };
  const groups = new Set(groupsOf(profile, settings.groupClaim));
  const matched = settings.groupRoles.filter((entry) => groups.has(entry.group)).map((entry) => entry.role);
  const roles = [...new Set(matched.length > 0 ? matched : settings.defaultRole ? [settings.defaultRole] : [])];
  if (roles.length === 0) return { allowed: false, reason: "no_matching_group" };
  const active = (db.prepare("SELECT id FROM workspaces WHERE organization_id=? AND status='active' ORDER BY id").all(settings.organizationId) as Array<{ id: string }>).map((row) => row.id);
  const workspaceIds = settings.workspaceIds.length > 0 ? settings.workspaceIds.filter((id) => active.includes(id)) : active;
  if (workspaceIds.length === 0) return { allowed: false, reason: "no_workspace" };
  return { allowed: true, roles, workspaceIds };
}

export function domainAllowed(settings: OidcSettings, email: string): boolean {
  if (settings.allowedDomains.length === 0) return true;
  return settings.allowedDomains.includes(email.slice(email.lastIndexOf("@") + 1).toLowerCase());
}

/**
 * Gives a newly created user the membership a decision allows, in one transaction: the vendor organization member, the Brain principal
 * and the workspace roles. Everything that can be refused was refused earlier, so this does not fail on policy.
 */
export function provisionUser(db: Db, settings: OidcSettings, user: { id: string; email: string }, decision: Extract<Decision, { allowed: true }>, now = Date.now()): void {
  const org = db.prepare("SELECT auth_organization_id FROM organizations WHERE id=?").get(settings.organizationId) as { auth_organization_id: string } | undefined;
  if (!org) throw new BrainDomainError("NOT_FOUND", "the organization of the single sign-on setting is missing");
  db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO member(id,organizationId,userId,role,createdAt) VALUES (?,?,?,?,?)").run(`member-${randomUUID()}`, org.auth_organization_id, user.id, "member", now);
    db.prepare("INSERT OR IGNORE INTO principals(id,organization_id,kind,auth_subject_id) VALUES (?,?,'human',?)").run(user.id, settings.organizationId, user.id);
    for (const workspaceId of decision.workspaceIds) {
      for (const role of decision.roles) {
        db.prepare("INSERT OR IGNORE INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES (?,?,?,?,1,?,?)")
          .run(workspaceId, settings.organizationId, user.id, role, `sso:${OIDC_PROVIDER_ID}`, now);
      }
    }
    db.prepare("INSERT OR REPLACE INTO identity_provisionings(user_id,organization_id,email,roles_json,workspace_ids_json,provisioned_at_ms) VALUES (?,?,?,?,?,?)")
      .run(user.id, settings.organizationId, user.email.toLowerCase(), JSON.stringify(decision.roles), JSON.stringify(decision.workspaceIds), now);
  }).immediate();
}

/** What Administration shows: everything except the secret, which is only ever named by its reference. */
export function oidcView(settings: OidcSettings | undefined, baseUrl: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const redirectUri = `${baseUrl.replace(/\/+$/u, "")}/api/auth/callback/${OIDC_PROVIDER_ID}`;
  if (!settings) return { configured: false, enabled: false, redirectUri };
  let secretReadable = true;
  try { resolveSecretRef(settings.secretRef, env); } catch { secretReadable = false; }
  return {
    configured: true, enabled: settings.enabled, issuer: settings.issuer, clientId: settings.clientId, secretRef: settings.secretRef, secretReadable, redirectUri,
    autoProvision: settings.autoProvision, ...(settings.defaultRole ? { defaultRole: settings.defaultRole } : {}), groupClaim: settings.groupClaim, groupRoles: settings.groupRoles,
    workspaceIds: settings.workspaceIds, allowedDomains: settings.allowedDomains, updatedBy: settings.updatedBy, updatedAt: new Date(settings.updatedAtMs).toISOString(),
  };
}
