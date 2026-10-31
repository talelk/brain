import type { betterAuth } from "better-auth";
import type { Db } from "../../infrastructure/persistence/open";
import type { authOptions } from "./options";

export type VendorAuth = ReturnType<typeof betterAuth<ReturnType<typeof authOptions>>> & {
  api: {
    listUsers(input: { headers: Headers; query: { limit: number; offset: number; searchValue?: string; searchField?: "email" | "name"; searchOperator?: "contains" | "starts_with" | "ends_with" } }): Promise<{ users: VendorUser[]; total: number }>;
    listUserSessions(input: { headers: Headers; body: { userId: string } }): Promise<{ sessions: VendorSession[] }>;
    revokeUserSession(input: { headers: Headers; body: { sessionToken: string } }): Promise<unknown>;
    createInvitation(input: { headers: Headers; body: { email: string; role: "member"; organizationId: string; resend: true } }): Promise<{ id: string }>;
    cancelInvitation(input: { headers: Headers; body: { invitationId: string } }): Promise<unknown>;
    createOrganization(input: { body: { userId: string; name: string; slug: string } }): Promise<{ id: string }>;
    verifyTOTP(input: { headers: Headers; body: { code: string; trustDevice: boolean } }): Promise<{ user: { id: string }; token?: string }>;
  };
};

export interface VendorUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly createdAt: Date | string | number;
  readonly twoFactorEnabled?: boolean | null;
}

export interface VendorSession {
  readonly id: string;
  readonly token: string;
  readonly userId: string;
  readonly userAgent?: string | null;
  readonly ipAddress?: string | null;
  readonly activeOrganizationId?: string | null;
  readonly createdAt: Date | string | number;
  readonly expiresAt: Date | string | number;
}

export interface IdentityAdministration {
  listUsers(headers: Headers, search?: string): Promise<VendorUser[]>;
  listUserSessions(headers: Headers, userId: string): Promise<VendorSession[]>;
  listSessions(headers: Headers): Promise<VendorSession[]>;
  createInvitation(headers: Headers, organizationId: string, email: string): Promise<{ id: string }>;
  cancelInvitation(headers: Headers, invitationId: string): Promise<void>;
  revokeUserSession(headers: Headers, token: string): Promise<void>;
  revokeSession(headers: Headers, token: string): Promise<void>;
  revokeOtherSessions(headers: Headers): Promise<void>;
  revokeSessions(headers: Headers): Promise<void>;
  retryInvitation(invitationId: string): void;
  syncVendorAdmin(userId: string): void;
}

export function createIdentityAdministration(db: Db, auth: VendorAuth): IdentityAdministration {
  return {
    async listUsers(headers, search) {
      const users: VendorUser[] = [];
      for (let offset = 0; offset < 1000; offset += 100) {
        const page = await auth.api.listUsers({ headers, query: { limit: 100, offset, ...(search ? { searchValue: search, searchField: "email", searchOperator: "contains" } : {}) } });
        users.push(...page.users.map((user) => {
          const twoFactorEnabled = (user as typeof user & { twoFactorEnabled?: boolean | null }).twoFactorEnabled;
          return { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified, createdAt: user.createdAt, ...(twoFactorEnabled !== undefined ? { twoFactorEnabled } : {}) };
        }));
        if (page.users.length < 100 || users.length >= page.total) break;
      }
      return users;
    },
    async listUserSessions(headers, userId) {
      const result = await auth.api.listUserSessions({ headers, body: { userId } });
      return result.sessions as VendorSession[];
    },
    async listSessions(headers) {
      return await auth.api.listSessions({ headers }) as VendorSession[];
    },
    async createInvitation(headers, organizationId, email) {
      const invitation = await auth.api.createInvitation({ headers, body: { email, role: "member", organizationId, resend: true } });
      return { id: invitation.id };
    },
    async cancelInvitation(headers, invitationId) {
      await auth.api.cancelInvitation({ headers, body: { invitationId } });
    },
    async revokeUserSession(headers, token) {
      await auth.api.revokeUserSession({ headers, body: { sessionToken: token } });
    },
    async revokeSession(headers, token) {
      await auth.api.revokeSession({ headers, body: { token } });
    },
    async revokeOtherSessions(headers) {
      await auth.api.revokeOtherSessions({ headers });
    },
    async revokeSessions(headers) {
      await auth.api.revokeSessions({ headers });
    },
    retryInvitation(invitationId) {
      const now = Date.now();
      const changed = db.prepare("UPDATE auth_email_outbox SET state='pending',attempt_count=0,last_error=NULL,updated_at_ms=? WHERE id=? AND state IN ('failed','pending')").run(now, `invitation:${invitationId}`);
      if (!changed.changes) db.prepare("INSERT OR IGNORE INTO auth_email_outbox(id,kind,email,url,organization_id,state,attempt_count,created_at_ms,updated_at_ms) SELECT ?,kind,email,url,organization_id,'pending',0,?,? FROM auth_email_outbox WHERE id=?").run(`invitation:${invitationId}`, now, now, `invitation:${invitationId}`);
    },
    syncVendorAdmin(userId) {
      const principal = db.prepare("SELECT auth_subject_id FROM principals WHERE id=?").get(userId) as { auth_subject_id: string } | undefined;
      const subjectId = principal?.auth_subject_id ?? userId;
      const rows = db.prepare("SELECT o.auth_organization_id,o.id AS organization_id,oa.role,oa.revoked_at_ms FROM organizations o LEFT JOIN organization_authorizations oa ON oa.organization_id=o.id AND oa.principal_id=?").all(userId) as Array<{ auth_organization_id: string; organization_id: string; role: string | null; revoked_at_ms: number | null }>;
      let globalAdmin = false;
      for (const row of rows) {
        const admin = !!row.role && ["organization-admin", "security-admin"].includes(row.role) && row.revoked_at_ms === null;
        globalAdmin ||= admin;
        db.prepare("UPDATE member SET role=CASE WHEN role='owner' THEN 'owner' ELSE ? END WHERE organizationId=? AND userId=?").run(admin ? "admin" : "member", row.auth_organization_id, subjectId);
      }
      db.prepare("UPDATE user SET role=? WHERE id=?").run(globalAdmin ? "admin" : "user", subjectId);
    },
  };
}
