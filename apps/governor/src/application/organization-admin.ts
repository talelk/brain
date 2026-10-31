import { validate } from "@brain/contracts/validate";
import { domainDigest } from "@brain/contracts";
import { authorizeCommand, type ResolvedActor } from "./authz";
import type { Store } from "./store";
import type { BrainAuth, VendorSession } from "../modules/identity/index";
import type { ActorContext, CommandReceipt, JsonValue, OrganizationAdminCommand, OrganizationAdminEventPayload, OrganizationAuthPolicyView, OrganizationDirectorySnapshot, OrganizationInvitationView, OrganizationMemberView, OrganizationSessionView } from "@brain/contracts";
import { BrainDomainError } from "../domain/errors";
import { assertExpectedVersion } from "../domain/states";
import type { IdentityAdministration } from "../modules/identity/index";

interface OrganizationCommand extends OrganizationAdminCommand { readonly payload: OrganizationAdminCommand["payload"] & Record<string, unknown> }
interface OrganizationQuery { readonly queryType: string; readonly resourceId?: string; readonly search?: string; readonly limit?: number; readonly cursor?: string }
interface OrganizationRow { readonly id: string; readonly auth_organization_id: string; readonly revocation_generation: number }
interface MemberRow { readonly userId: string; readonly role: string; readonly createdAt: Date | string | number }

export function isOrganizationCommand(raw: unknown): boolean {
  return typeof (raw as { commandType?: unknown } | null)?.commandType === "string" && (raw as { commandType: string }).commandType.startsWith("organization.");
}

export function isOrganizationQuery(raw: unknown): boolean {
  return typeof (raw as { queryType?: unknown } | null)?.queryType === "string" && (raw as { queryType: string }).queryType.startsWith("organization.");
}

function organization(store: Store, actor: ActorContext): OrganizationRow {
  const row = store.control.prepare("SELECT id,auth_organization_id,revocation_generation FROM organizations WHERE id=?").get(actor.organizationId) as OrganizationRow | undefined;
  if (!row) throw new BrainDomainError("UNAUTHENTICATED", "organization missing");
  return row;
}

function requireIdentityRead(actor: ActorContext): void {
  if (actor.kind !== "human" || !actor.scopes.includes("identity:read")) throw new BrainDomainError("FORBIDDEN", "identity administration read scope required");
}

function principal(store: Store, actor: ActorContext, principalId: string, includeDisabled = false): { id: string; auth_subject_id: string; disabled_at_ms: number | null } {
  const row = store.control.prepare(`SELECT id,auth_subject_id,disabled_at_ms FROM principals WHERE id=? AND organization_id=? AND kind='human'${includeDisabled ? "" : " AND disabled_at_ms IS NULL"}`).get(principalId, actor.organizationId) as { id: string; auth_subject_id: string; disabled_at_ms: number | null } | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", "organization member not found");
  return row;
}

function iso(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "identity provider returned an invalid timestamp");
  return date.toISOString();
}

function sessionView(session: VendorSession, currentSessionId?: string): OrganizationSessionView {
  return {
    id: session.id,
    userId: session.userId,
    ...(session.userAgent ? { userAgent: session.userAgent.slice(0, 512) } : {}),
    ...(session.ipAddress ? { ipAddress: session.ipAddress.slice(0, 128) } : {}),
    createdAt: iso(session.createdAt),
    expiresAt: iso(session.expiresAt),
    ...(currentSessionId ? { current: session.id === currentSessionId } : {}),
  };
}

function memberView(store: Store, org: OrganizationRow, user: { id: string; name: string; email: string; emailVerified: boolean; createdAt: Date | string | number; twoFactorEnabled?: boolean | null }, principalId: string): OrganizationMemberView {
  const current = store.control.prepare("SELECT disabled_at_ms FROM principals WHERE id=? AND organization_id=? AND kind='human'").get(principalId, org.id) as { disabled_at_ms: number | null } | undefined;
  const roles = store.control.prepare("SELECT role FROM organization_authorizations WHERE organization_id=? AND principal_id=? AND revoked_at_ms IS NULL ORDER BY role").all(org.id, principalId) as Array<{ role: OrganizationMemberView["roles"][number] }>;
  const workspaceCount = store.control.prepare("SELECT COUNT(DISTINCT workspace_id) AS count FROM workspace_memberships WHERE organization_id=? AND principal_id=? AND revoked_at_ms IS NULL").get(org.id, principalId) as { count: number };
  const passkeyCount = store.control.prepare("SELECT COUNT(*) AS count FROM passkey WHERE userId=?").get(user.id) as { count: number };
  const sessionCount = store.control.prepare("SELECT COUNT(*) AS count FROM session WHERE userId=? AND activeOrganizationId=? AND expiresAt>?").get(user.id, org.auth_organization_id, store.now()) as { count: number };
  return {
    id: user.id,
    principalId,
    name: user.name.slice(0, 256),
    email: user.email,
    emailVerified: user.emailVerified,
    status: current && current.disabled_at_ms === null ? "active" : "suspended",
    roles: roles.map((row) => row.role),
    workspaceCount: workspaceCount.count,
    totpEnrolled: !!user.twoFactorEnabled,
    passkeyCount: passkeyCount.count,
    sessionCount: sessionCount.count,
    version: org.revocation_generation,
    createdAt: iso(user.createdAt),
  };
}

function envelope(store: Store, queryType: string, snapshot: OrganizationDirectorySnapshot, cursor = ""): JsonValue {
  const watermark = store.control.prepare("SELECT COALESCE(MAX(cursor),0) AS cursor FROM events").get() as { cursor: number };
  return { queryType, snapshot: snapshot as unknown as JsonValue, cursor, sourceWatermark: watermark.cursor, asOf: store.nowIso(), projectionLagMs: 0 } as unknown as JsonValue;
}

async function organizationUsers(auth: IdentityAdministration, store: Store, org: OrganizationRow, headers: Headers, search?: string): Promise<OrganizationMemberView[]> {
  const [users, members, principals] = await Promise.all([
    auth.listUsers(headers),
    Promise.resolve(store.control.prepare("SELECT userId,role,createdAt FROM member WHERE organizationId=?").all(org.auth_organization_id) as MemberRow[]),
    Promise.resolve(store.control.prepare("SELECT id,auth_subject_id FROM principals WHERE organization_id=? AND kind='human'").all(org.id) as Array<{ id: string; auth_subject_id: string }>),
  ]);
  const memberIds = new Set(members.map((member) => member.userId));
  const principalBySubject = new Map(principals.map((item) => [item.auth_subject_id, item.id]));
  const needle = search?.toLowerCase();
  return users.filter((user) => memberIds.has(user.id) && (!needle || user.email.toLowerCase().includes(needle) || user.name.toLowerCase().includes(needle)))
    .map((user) => memberView(store, org, user, principalBySubject.get(user.id) ?? user.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email) || a.id.localeCompare(b.id));
}

function invitations(store: Store, org: OrganizationRow): OrganizationInvitationView[] {
  const rows = store.control.prepare(`SELECT i.*,o.state AS delivery_state,o.attempt_count,o.last_error FROM invitation i
    LEFT JOIN auth_email_outbox o ON o.id='invitation:' || i.id WHERE i.organizationId=? ORDER BY i.createdAt DESC LIMIT 1000`).all(org.auth_organization_id) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const expiresAt = row["expiresAt"] as Date | string | number;
    const createdAt = row["createdAt"] as Date | string | number;
    const expiresAtMs = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
    const stored = String(row["status"]);
    const status = stored === "pending" && expiresAtMs <= store.now() ? "expired" : stored;
    return {
      id: String(row["id"]),
      email: String(row["email"]),
      status,
      role: String(row["role"] ?? "member"),
      inviterId: String(row["inviterId"]),
      deliveryState: status === "canceled" ? "cancelled" : String(row["delivery_state"] ?? "not-queued"),
      deliveryAttempts: Number(row["attempt_count"] ?? 0),
      ...(row["last_error"] ? { lastError: String(row["last_error"]).slice(0, 512) } : {}),
      expiresAt: iso(expiresAt),
      createdAt: iso(createdAt),
    } as OrganizationInvitationView;
  });
}

export async function executeOrganizationQuery(store: Store, auth: BrainAuth, actor: ActorContext, raw: unknown, headers: Headers): Promise<JsonValue> {
  const check = validate("QueryRequest", raw);
  if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", check.errors.join("; "));
  const q = raw as OrganizationQuery;
  requireIdentityRead(actor);
  const org = organization(store, actor);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const offset = q.cursor && /^\d+$/u.test(q.cursor) ? Number(q.cursor) : 0;
  if (q.queryType === "organization.auth-policy.get") {
    const policy: OrganizationAuthPolicyView = { oidcEnabled: !!process.env["BRAIN_OIDC_ISSUER"], passwordEnabled: true, passkeyEnabled: true, requireTwoFactor: auth.requireTwoFactor, sessionExpiresInSeconds: 43_200, sessionFreshAgeSeconds: 300, rateLimitStorage: "database", configurationSource: "governor-runtime" };
    return envelope(store, q.queryType, { members: [], invitations: [], sessions: [], policy });
  }
  if (q.queryType === "organization.invitations.list") {
    const all = invitations(store, org).filter((item) => !q.search || item.email.toLowerCase().includes(q.search.toLowerCase()));
    return envelope(store, q.queryType, { members: [], invitations: all.slice(offset, offset + limit), sessions: [], totalEstimate: all.length }, offset + limit < all.length ? String(offset + limit) : "");
  }
  if (q.queryType === "organization.members.list") {
    const all = await organizationUsers(auth.administration, store, org, headers, q.search);
    return envelope(store, q.queryType, { members: all.slice(offset, offset + limit), invitations: [], sessions: [], totalEstimate: all.length }, offset + limit < all.length ? String(offset + limit) : "");
  }
  if (q.queryType === "organization.member.get") {
    if (!q.resourceId) throw new BrainDomainError("INVALID_ARGUMENT", "principalId required");
    principal(store, actor, q.resourceId, true);
    const all = await organizationUsers(auth.administration, store, org, headers);
    const member = all.find((item) => item.principalId === q.resourceId);
    if (!member) throw new BrainDomainError("NOT_FOUND", "organization member not found");
    const sessions = (await auth.administration.listUserSessions(headers, member.id))
      .filter((session) => session.activeOrganizationId === org.auth_organization_id)
      .map((session) => sessionView(session));
    const events = (store.control.prepare("SELECT event_type,occurred_at_ms FROM auth_security_events WHERE user_id=? AND (auth_organization_id=? OR auth_organization_id IS NULL) ORDER BY id DESC LIMIT 100").all(member.id, org.auth_organization_id) as Array<{ event_type: string; occurred_at_ms: number }>)
      .map((event) => ({ eventType: event.event_type, occurredAt: iso(event.occurred_at_ms) }));
    return envelope(store, q.queryType, { members: [], invitations: [], sessions, events, member });
  }
  throw new BrainDomainError("INVALID_CONTRACT", `unknown organization query ${q.queryType}`);
}

export async function executeOrganizationCommand(store: Store, auth: BrainAuth, actor: ActorContext, raw: unknown, headers: Headers): Promise<{ receipt: CommandReceipt; status: number }> {
  const check = validate("CommandEnvelope", raw);
  if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", `command invalid: ${check.errors.join("; ")}`);
  const cmd = raw as OrganizationCommand;
  authorizeCommand(actor, cmd.commandType);
  const p = cmd.payload;
  const requestDigest = domainDigest("brain:command:v1", raw as JsonValue);
  const prior = store.control.prepare("SELECT request_digest,receipt_json FROM command_idempotency WHERE organization_id=? AND actor_id=? AND command_type=? AND idempotency_key=?").get(actor.organizationId, actor.actorId, cmd.commandType, cmd.idempotencyKey) as { request_digest: string; receipt_json: string } | undefined;
  if (prior) {
    if (prior.request_digest !== requestDigest) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "same idempotency key with different payload");
    return { receipt: JSON.parse(prior.receipt_json) as CommandReceipt, status: 200 };
  }
  const org = organization(store, actor);
  assertExpectedVersion(org.revocation_generation, cmd.expectedVersion);
  let resourceId = String(p.principalId ?? p.invitationId ?? p.sessionId ?? "");

  if (cmd.commandType === "organization.invitation.create") {
    if (!p.email) throw new BrainDomainError("INVALID_ARGUMENT", "email required");
    store.control.prepare("INSERT OR REPLACE INTO command_intents(command_id,workspace_id,request_json,state,created_at_ms) VALUES (?,NULL,?,?,?)").run(cmd.commandId, JSON.stringify(raw), "pending", store.now());
    try {
      const invitation = await auth.administration.createInvitation(headers, org.auth_organization_id, p.email.toLowerCase());
      resourceId = invitation.id;
    } catch (error) {
      store.control.prepare("UPDATE command_intents SET state='failed' WHERE command_id=?").run(cmd.commandId);
      throw error;
    }
  } else if (cmd.commandType === "organization.invitation.cancel") {
    if (!p.invitationId) throw new BrainDomainError("INVALID_ARGUMENT", "invitationId required");
    const owned = store.control.prepare("SELECT 1 AS owned FROM invitation WHERE id=? AND organizationId=?").get(p.invitationId, org.auth_organization_id);
    if (!owned) throw new BrainDomainError("NOT_FOUND", "invitation not found");
    store.control.prepare("INSERT OR REPLACE INTO command_intents(command_id,workspace_id,request_json,state,created_at_ms) VALUES (?,NULL,?,?,?)").run(cmd.commandId, JSON.stringify(raw), "pending", store.now());
    try {
      await auth.administration.cancelInvitation(headers, p.invitationId);
    } catch (error) {
      store.control.prepare("UPDATE command_intents SET state='failed' WHERE command_id=?").run(cmd.commandId);
      throw error;
    }
  } else if (cmd.commandType === "organization.invitation.retry") {
    if (!p.invitationId) throw new BrainDomainError("INVALID_ARGUMENT", "invitationId required");
    const owned = store.control.prepare("SELECT status FROM invitation WHERE id=? AND organizationId=?").get(p.invitationId, org.auth_organization_id) as { status: string } | undefined;
    if (!owned) throw new BrainDomainError("NOT_FOUND", "invitation not found");
    if (owned.status !== "pending") throw new BrainDomainError("CONFLICT", "only a pending invitation can be retried");
  } else if (cmd.commandType === "organization.session.revoke") {
    if (!p.principalId || !p.sessionId) throw new BrainDomainError("INVALID_ARGUMENT", "principalId and sessionId required");
    const target = principal(store, actor, p.principalId, true);
    const session = (await auth.administration.listUserSessions(headers, target.auth_subject_id)).find((item) => item.id === p.sessionId && item.activeOrganizationId === org.auth_organization_id);
    if (!session) throw new BrainDomainError("NOT_FOUND", "current-organization session not found");
    await auth.administration.revokeUserSession(headers, session.token);
  } else if (cmd.commandType === "organization.member.role-grant" || cmd.commandType === "organization.member.role-revoke") {
    if (!p.principalId || !p.role) throw new BrainDomainError("INVALID_ARGUMENT", "principalId and role required");
    principal(store, actor, p.principalId);
    const held = store.control.prepare("SELECT 1 AS held FROM organization_authorizations WHERE organization_id=? AND principal_id=? AND role=? AND revoked_at_ms IS NULL").get(actor.organizationId, actor.actorId, p.role);
    if (!held) throw new BrainDomainError("FORBIDDEN", "cannot manage a role not held by the caller");
    if (cmd.commandType === "organization.member.role-revoke" && p.role === "organization-admin") {
      const admins = store.control.prepare("SELECT COUNT(*) AS count FROM organization_authorizations WHERE organization_id=? AND role='organization-admin' AND revoked_at_ms IS NULL").get(actor.organizationId) as { count: number };
      if (admins.count <= 1) throw new BrainDomainError("CONFLICT", "last organization administrator cannot be removed");
    }
  } else if (cmd.commandType === "organization.member.suspend" || cmd.commandType === "organization.member.reactivate") {
    if (!p.principalId) throw new BrainDomainError("INVALID_ARGUMENT", "principalId required");
    principal(store, actor, p.principalId, true);
    if (cmd.commandType === "organization.member.suspend") {
      if (p.principalId === actor.actorId) throw new BrainDomainError("CONFLICT", "administrators cannot suspend themselves");
      const admins = store.control.prepare("SELECT COUNT(*) AS count FROM organization_authorizations WHERE organization_id=? AND role='organization-admin' AND revoked_at_ms IS NULL").get(actor.organizationId) as { count: number };
      const targetAdmin = store.control.prepare("SELECT 1 AS admin FROM organization_authorizations WHERE organization_id=? AND principal_id=? AND role='organization-admin' AND revoked_at_ms IS NULL").get(actor.organizationId, p.principalId);
      if (targetAdmin && admins.count <= 1) throw new BrainDomainError("CONFLICT", "last organization administrator cannot be suspended");
    }
  }

  let receipt!: CommandReceipt;
  store.inTx(store.control, () => {
    const current = organization(store, actor);
    assertExpectedVersion(current.revocation_generation, cmd.expectedVersion);
    const repeated = store.control.prepare("SELECT request_digest,receipt_json FROM command_idempotency WHERE organization_id=? AND actor_id=? AND command_type=? AND idempotency_key=?").get(actor.organizationId, actor.actorId, cmd.commandType, cmd.idempotencyKey) as { request_digest: string; receipt_json: string } | undefined;
    if (repeated) {
      if (repeated.request_digest !== requestDigest) throw new BrainDomainError("IDEMPOTENCY_CONFLICT", "same idempotency key with different payload");
      receipt = JSON.parse(repeated.receipt_json) as CommandReceipt;
      return;
    }
    if (cmd.commandType === "organization.member.role-grant" || cmd.commandType === "organization.member.role-revoke") {
      if (cmd.commandType === "organization.member.role-grant") {
        store.control.prepare("INSERT INTO organization_authorizations(organization_id,principal_id,role,granted_by,granted_at_ms,revoked_at_ms) VALUES (?,?,?,?,?,NULL) ON CONFLICT(organization_id,principal_id,role) DO UPDATE SET revoked_at_ms=NULL,granted_by=excluded.granted_by,granted_at_ms=excluded.granted_at_ms").run(actor.organizationId, p.principalId, p.role, actor.actorId, store.now());
      } else {
        store.control.prepare("UPDATE organization_authorizations SET revoked_at_ms=? WHERE organization_id=? AND principal_id=? AND role=? AND revoked_at_ms IS NULL").run(store.now(), actor.organizationId, p.principalId, p.role);
      }
      auth.administration.syncVendorAdmin(String(p.principalId));
    }
    if (cmd.commandType === "organization.member.suspend" || cmd.commandType === "organization.member.reactivate") {
      const suspended = cmd.commandType === "organization.member.suspend";
      store.control.prepare("UPDATE principals SET disabled_at_ms=? WHERE id=? AND organization_id=?").run(suspended ? store.now() : null, p.principalId, actor.organizationId);
      if (suspended) store.control.prepare("DELETE FROM session WHERE userId=? AND activeOrganizationId=?").run(p.principalId, org.auth_organization_id);
    }
    if (cmd.commandType === "organization.invitation.cancel") store.control.prepare("UPDATE auth_email_outbox SET state='cancelled',updated_at_ms=? WHERE id=?").run(store.now(), `invitation:${String(p.invitationId)}`);
    if (cmd.commandType === "organization.invitation.retry") auth.administration.retryInvitation(String(p.invitationId));
    store.control.prepare("UPDATE organizations SET revocation_generation=revocation_generation+1 WHERE id=?").run(actor.organizationId);
    const generation = current.revocation_generation + 1;
    const payload: OrganizationAdminEventPayload = {
      ...(p.principalId ? { principalId: p.principalId } : {}),
      ...(p.invitationId || cmd.commandType === "organization.invitation.create" ? { invitationId: p.invitationId ?? resourceId } : {}),
      ...(p.sessionId ? { sessionId: p.sessionId } : {}),
      ...(p.role ? { role: p.role } : {}),
      reason: p.reason,
      revocationGeneration: generation,
    };
    store.emit(store.control, { organizationId: actor.organizationId, aggregateType: "identity", aggregateId: resourceId || actor.actorId, eventType: cmd.commandType, payload });
    receipt = { commandId: cmd.commandId, accepted: true, outcome: "applied", ...(resourceId ? { resourceId } : {}) };
    store.control.prepare("INSERT OR REPLACE INTO command_intents(command_id,workspace_id,request_json,state,created_at_ms) VALUES (?,NULL,?,?,?)").run(cmd.commandId, JSON.stringify(raw), "applied", store.now());
    store.control.prepare("INSERT INTO command_idempotency(organization_id,actor_id,command_type,idempotency_key,request_digest,command_id,receipt_json,created_at_ms) VALUES (?,?,?,?,?,?,?,?)").run(actor.organizationId, actor.actorId, cmd.commandType, cmd.idempotencyKey, requestDigest, cmd.commandId, JSON.stringify(receipt), store.now());
  });
  return { receipt, status: 200 };
}

export async function listIdentitySessions(auth: BrainAuth, identity: ResolvedActor, headers: Headers): Promise<OrganizationSessionView[]> {
  if (!identity.humanSession) throw new BrainDomainError("UNAUTHENTICATED", "human session required");
  return (await auth.administration.listSessions(headers)).map((session) => sessionView(session, identity.humanSession!.sessionId));
}

export async function revokeIdentitySession(auth: BrainAuth, identity: ResolvedActor, headers: Headers, mode: "one" | "others" | "all", sessionId?: string): Promise<void> {
  if (!identity.humanSession) throw new BrainDomainError("UNAUTHENTICATED", "human session required");
  if (mode === "others") return auth.administration.revokeOtherSessions(headers);
  if (mode === "all") return auth.administration.revokeSessions(headers);
  if (!sessionId) throw new BrainDomainError("INVALID_ARGUMENT", "sessionId required");
  const session = (await auth.administration.listSessions(headers)).find((item) => item.id === sessionId);
  if (!session) throw new BrainDomainError("NOT_FOUND", "session not found");
  await auth.administration.revokeSession(headers, session.token);
}
