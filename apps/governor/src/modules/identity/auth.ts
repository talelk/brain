import { betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { domainDigest } from "@brain/contracts";
import type { Db } from "../../infrastructure/persistence/open";
import { BrainDomainError } from "../../domain/errors";
import { authOptions } from "./options";
import { createIdentityAdministration, type IdentityAdministration, type VendorAuth } from "./administration";

export interface VerifiedSession {
  readonly userId: string;
  readonly displayName: string;
  readonly sessionId: string;
  readonly activeOrganizationId: string | null;
  readonly factorDigest: string | null;
  readonly recoveryRequired: boolean;
  readonly passwordChangeRequired?: boolean;
}

export interface BrainAuth {
  readonly requireTwoFactor: boolean;
  readonly administration: IdentityAdministration;
  handler(request: Request): Promise<Response>;
  ready(): Promise<void>;
  readSession(headers: Headers): Promise<VerifiedSession | null>;
  hasMembership(userId: string, organizationId: string): boolean;
  isSessionCurrent(userId: string, sessionId: string, nowMs: number, factorDigest?: string | null): boolean;
  verifyTotp(headers: Headers, code: string): Promise<boolean>;
  bootstrapAccount(input: { email: string; password: string; name: string }): Promise<{ userId: string; token: string; cookies: string[] }>;
  bootstrapOrganization(userId: string, slug: string, name: string): Promise<string>;
  ensureTables(): string[];
  revokeAllSessions(): void;
}

interface TableDef { modelName: string; fields: Record<string, { fieldName?: string }> }
const quote = (id: string) => `"${id.replaceAll('"', '""')}"`;

export function createBrainAuth(db: Db, opts: { secret: string; baseURL: string; requireTwoFactor?: boolean; initialPasswordFile?: string }): BrainAuth {
  const sql = readFileSync(new URL("../../../schema/auth.sql", import.meta.url), "utf8");
  const securitySql = "CREATE TABLE brain_auth_recovery(user_id TEXT PRIMARY KEY, factor_digest TEXT NOT NULL, recovered_at_ms INTEGER NOT NULL) STRICT";
  const passwordSql = "CREATE TABLE brain_initial_password(user_id TEXT PRIMARY KEY, password_hash TEXT NOT NULL) STRICT";
  const deliverySql = "CREATE TABLE auth_email_outbox(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('verify-email','organization-invitation','password-reset')), email TEXT NOT NULL, url TEXT NOT NULL, organization_id TEXT, state TEXT NOT NULL CHECK(state IN ('pending','delivered','failed','cancelled')), attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT";
  const securityEventsSql = "CREATE TABLE auth_security_events(id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, user_id TEXT, auth_organization_id TEXT, occurred_at_ms INTEGER NOT NULL) STRICT";
  const schemaDigest = `sha256:${createHash("sha256").update(sql).update(securitySql).update(passwordSql).update(deliverySql).update(securityEventsSql).digest("hex")}`;
  // Only apply the vendor-generated initial schema to an empty auth namespace.
  // An existing, different schema is preserved and rejected, never converted.
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user'").get();
  if (!existing) db.transaction(() => {
    db.exec(sql);
    db.exec(securitySql);
    db.exec(passwordSql);
    db.exec(deliverySql);
    db.exec(securityEventsSql);
    db.exec("CREATE TABLE auth_schema_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1), digest TEXT NOT NULL) STRICT");
    db.prepare("INSERT INTO auth_schema_metadata VALUES (1,?)").run(schemaDigest);
  }).immediate();
  else {
    const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_schema_metadata'").get();
    const row = meta ? db.prepare("SELECT digest FROM auth_schema_metadata WHERE singleton=1").get() as { digest: string } | undefined : undefined;
    if (row?.digest !== schemaDigest) throw new BrainDomainError("UPGRADE_REQUIRED", "existing auth schema differs from the selected current schema; preserved");
  }

  const auth = betterAuth(authOptions(db, opts)) as VendorAuth;
  const administration = createIdentityAdministration(db, auth);
  const tables = getAuthTables(auth.options) as unknown as Record<string, TableDef>;
  const table = (name: string) => {
    const value = tables[name];
    if (!value) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", `missing selected auth model: ${name}`);
    return quote(value.modelName);
  };
  const field = (model: string, name: string) => quote(tables[model]?.fields[name]?.fieldName ?? name);

  function rawFactorDigest(userId: string): string | null {
    const user = db.prepare(`SELECT ${field("user", "twoFactorEnabled")} AS enabled FROM ${table("user")} WHERE id=?`).get(userId) as { enabled: number | null } | undefined;
    if (!user?.enabled) return null;
    const factor = db.prepare(`SELECT id, ${field("twoFactor", "secret")} AS secret, ${field("twoFactor", "verified")} AS verified FROM ${table("twoFactor")} WHERE ${field("twoFactor", "userId") }=?`).all(userId) as Array<{ id: string; secret: string; verified: number | null }>;
    if (factor.length !== 1 || factor[0]?.verified !== 1) return null;
    return domainDigest("brain:auth-factor:v1", { id: factor[0].id, ciphertext: factor[0].secret });
  }

  function recoveryRequired(userId: string, current: string | null): boolean {
    const row = db.prepare("SELECT factor_digest FROM brain_auth_recovery WHERE user_id=?").get(userId) as { factor_digest: string } | undefined;
    return !!current && row?.factor_digest === current;
  }
  function factorDigest(userId: string): string | null {
    const current = rawFactorDigest(userId);
    return recoveryRequired(userId, current) ? null : current;
  }

  async function readSession(headers: Headers): Promise<VerifiedSession | null> {
    const value = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!value) return null;
    const session = value.session as typeof value.session & { activeOrganizationId?: string | null };
    const current = rawFactorDigest(value.user.id); const recovered = recoveryRequired(value.user.id,current);
    const initial = db.prepare("SELECT password_hash FROM brain_initial_password WHERE user_id=?").get(value.user.id) as { password_hash: string } | undefined;
    const credential = db.prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'").get(value.user.id) as { password: string } | undefined;
    const passwordChangeRequired = !!initial && initial.password_hash === credential?.password;
    if (initial && !passwordChangeRequired) {
      db.prepare("DELETE FROM brain_initial_password WHERE user_id=?").run(value.user.id);
      if (opts.initialPasswordFile && existsSync(opts.initialPasswordFile)) unlinkSync(opts.initialPasswordFile);
    }
    return { passwordChangeRequired, userId: value.user.id, displayName: value.user.name.slice(0,256), sessionId: session.id, activeOrganizationId: session.activeOrganizationId ?? null, factorDigest: recovered ? null : current, recoveryRequired: recovered };
  }

  return {
    requireTwoFactor: opts.requireTwoFactor ?? false,
    administration,
    async handler(request) {
      const response = await auth.handler(request);
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/api/auth/two-factor/verify-backup-code" && response.ok) {
        const value = await response.clone().json() as { user?: { id?: string }; token?: string };
        // A recovery sign-in restores account access. Its existing factor must
        // be replaced before it can produce new effect-approval evidence.
        if (value.user?.id && value.token) {
          const digest = rawFactorDigest(value.user.id);
          if (digest) db.prepare("INSERT INTO brain_auth_recovery(user_id,factor_digest,recovered_at_ms) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET factor_digest=excluded.factor_digest,recovered_at_ms=excluded.recovered_at_ms").run(value.user.id,digest,Date.now());
        }
      }
      if (request.method === "POST" && path === "/api/auth/organization/accept-invitation" && response.ok) {
        const value = await response.clone().json() as { member?: { userId?: string; organizationId?: string } };
        if (value.member?.userId && value.member.organizationId) {
          const organization = db.prepare("SELECT id FROM organizations WHERE auth_organization_id=?").get(value.member.organizationId) as { id: string } | undefined;
          if (!organization) throw new BrainDomainError("CONFLICT", "accepted organization is not registered in Brain");
          db.prepare("INSERT OR IGNORE INTO principals(id,organization_id,kind,auth_subject_id) VALUES (?,?,'human',?)").run(value.member.userId, organization.id, value.member.userId);
        }
      }
      return response;
    },
    async ready() { await auth.$context; },
    ensureTables: () => Object.values(tables).map((t) => t.modelName).sort(),
    readSession,
    hasMembership(userId, organizationId) {
      return !!db.prepare(`SELECT 1 FROM ${table("member")} WHERE ${field("member", "userId") }=? AND ${field("member", "organizationId") }=?`).get(userId, organizationId);
    },
    isSessionCurrent(userId, sessionId, nowMs, expectedFactor) {
      const row = db.prepare(`SELECT ${field("session", "expiresAt")} AS expiry FROM ${table("session")} WHERE id=? AND ${field("session", "userId") }=?`).get(sessionId, userId) as { expiry: number | string } | undefined;
      if (!row) return false;
      const expiry = typeof row.expiry === "number" ? row.expiry : new Date(row.expiry).getTime();
      return expiry > nowMs && (expectedFactor === undefined || factorDigest(userId) === expectedFactor);
    },
    async verifyTotp(headers, code) {
      const identity = await readSession(headers);
      if (!identity?.factorDigest || !/^\d{6}$/u.test(code)) return false;
      try {
        const value = await auth.api.verifyTOTP({ headers, body: { code, trustDevice: false } });
        return value.user.id === identity.userId && typeof value.token === "string" && this.isSessionCurrent(identity.userId, identity.sessionId, Date.now(), identity.factorDigest);
      } catch { return false; }
    },
    async bootstrapAccount(input) {
      // Existing users must prove their password; no client user ID is trusted.
      const user = db.prepare(`SELECT id FROM ${table("user")} WHERE ${field("user", "email") }=?`).get(input.email);
      const response = user
        ? await auth.api.signInEmail({ body: { email: input.email, password: input.password }, asResponse: true })
        : await auth.api.signUpEmail({ body: input, asResponse: true });
      if (!response.ok) throw new BrainDomainError("UNAUTHENTICATED", "setup authentication failed");
      const body = await response.json() as { token?: string; user?: { id: string }; twoFactorRedirect?: boolean };
      if (!body.token || !body.user?.id || body.twoFactorRedirect) throw new BrainDomainError("FORBIDDEN", "complete strong sign-in before setup");
      db.prepare(`UPDATE ${table("user")} SET ${field("user", "role")}='admin' WHERE id=?`).run(body.user.id);
      return { userId: body.user.id, token: response.headers.get("set-auth-token") ?? body.token, cookies: response.headers.getSetCookie() };
    },
    async bootstrapOrganization(userId, slug, name) {
      const prior = db.prepare(`SELECT id FROM ${table("organization")} WHERE ${field("organization", "slug") }=?`).get(slug) as { id: string } | undefined;
      if (prior) {
        const owner = db.prepare(`SELECT 1 FROM ${table("member")} WHERE ${field("member", "userId") }=? AND ${field("member", "organizationId") }=? AND ${field("member", "role") }='owner'`).get(userId, prior.id);
        if (!owner) throw new BrainDomainError("FORBIDDEN", "setup organization owner mismatch");
        return prior.id;
      }
      // Better Auth explicitly supports this server-only system action. Public
      // organization creation remains disabled by the selected plugin options.
      const value = await auth.api.createOrganization({ body: { userId, name, slug } });
      return value.id;
    },
    revokeAllSessions() { db.prepare(`DELETE FROM ${table("session")}`).run(); },
  };
}
