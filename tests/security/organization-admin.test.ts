import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { setupCredential } from "../helpers";
import type { OrganizationAdminCommand, OrganizationDirectorySnapshot, OrganizationSessionView } from "@brain/contracts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function application() {
  const dir = mkdtempSync(join(tmpdir(), "brain-organization-admin-"));
  const app = await createApp({ dataDir: dir });
  cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const send = (path: string, body: unknown, token?: string) => app.fetch(new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }));
  const get = (path: string, token?: string) => app.fetch(new Request(`http://127.0.0.1:3000${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  return { app, send, get };
}

function command(input: OrganizationAdminCommand["commandType"], expectedVersion: number, payload: OrganizationAdminCommand["payload"], suffix: string): OrganizationAdminCommand {
  return { contractVersion: "brain.command/v1", commandId: `cmd-${suffix}`, commandType: input, idempotencyKey: `idem-${suffix}`, expectedVersion, payload };
}

describe("organization identity administration", () => {
  it("administers only current-organization users and preserves role/session invariants", async () => {
    const { app, send, get } = await application();
    const password = "organization-owner-password";
    const boot = await app.brain.bootstrap({ organizationId: "org-admin", name: "Admin", email: "owner@example.test", password }, setupCredential(app.brain));
    const token = boot.sessionToken;
    const authOrg = app.brain.store.control.prepare("SELECT auth_organization_id AS id FROM organizations WHERE id='org-admin'").get() as { id: string };

    const initial = await send("/v1/query", { queryType: "organization.members.list" }, token);
    expect(initial.status).toBe(200);
    const initialView = await initial.json() as { snapshot: OrganizationDirectorySnapshot };
    expect(initialView.snapshot.members.map((member) => member.email)).toEqual(["owner@example.test"]);

    expect((await send("/api/auth/admin/list-users", {}, token)).status).toBe(403);
    expect((await send("/v1/query", { queryType: "organization.member.get", resourceId: "foreign-user" }, token)).status).toBe(404);
    expect((await send("/v1/commands", command("organization.member.role-revoke", 1, { principalId: boot.ownerPrincipalId, role: "organization-admin", reason: "Try to remove last administrator" }, "last-admin"), token)).status).toBe(409);

    const invite = await send("/v1/commands", command("organization.invitation.create", 1, { email: "member@example.test", reason: "Invite member" }, "invite"), token);
    expect(invite.status).toBe(200);
    const invitationId = (await invite.json() as { resourceId: string }).resourceId;
    const signup = await send("/api/auth/sign-up/email", { email: "member@example.test", password: "organization-member-password", name: "Member" });
    const account = await signup.json() as { token: string; user: { id: string } };
    app.brain.store.control.prepare("UPDATE user SET emailVerified=1 WHERE id=?").run(account.user.id);
    expect((await send("/api/auth/organization/accept-invitation", { invitationId }, account.token)).status).toBe(200);
    app.brain.store.control.prepare("UPDATE session SET activeOrganizationId=? WHERE userId=?").run(authOrg.id, account.user.id);

    const grant = command("organization.member.role-grant", 2, { principalId: account.user.id, role: "organization-admin", reason: "Delegate administration" }, "grant");
    expect((await send("/v1/commands", grant, token)).status).toBe(200);
    expect((await send("/v1/commands", grant, token)).status).toBe(200);
    expect(app.brain.store.control.prepare("SELECT role FROM user WHERE id=?").get(account.user.id)).toEqual({ role: "admin" });
    expect(app.brain.store.control.prepare("SELECT revocation_generation AS generation FROM organizations WHERE id='org-admin'").get()).toEqual({ generation: 3 });

    const detail = await send("/v1/query", { queryType: "organization.member.get", resourceId: account.user.id }, token);
    const detailView = await detail.json() as { snapshot: OrganizationDirectorySnapshot };
    expect(detailView.snapshot.member?.roles).toEqual(["organization-admin"]);
    expect(detailView.snapshot.sessions).toHaveLength(1);
    expect(detailView.snapshot.events?.map((event) => event.eventType)).toContain("organization.invitation.accepted");
    expect(JSON.stringify(detailView)).not.toContain(account.token);

    expect((await send("/v1/commands", command("organization.member.role-revoke", 3, { principalId: account.user.id, role: "organization-admin", reason: "Remove delegation" }, "revoke"), token)).status).toBe(200);
    expect((await send("/v1/commands", command("organization.session.revoke", 4, { principalId: account.user.id, sessionId: detailView.snapshot.sessions[0]!.id, reason: "Revoke organization session" }, "revoke-session"), token)).status).toBe(200);
    expect((await send("/v1/commands", command("organization.member.suspend", 5, { principalId: account.user.id, reason: "Suspend membership" }, "suspend"), token)).status).toBe(200);
    expect((await get("/v1/identity", account.token)).status).toBe(401);
    expect(app.brain.store.control.prepare("SELECT COUNT(*) AS count FROM session WHERE userId=? AND activeOrganizationId=?").get(account.user.id, authOrg.id)).toEqual({ count: 0 });

    expect((await send("/v1/commands", command("organization.member.reactivate", 6, { principalId: account.user.id, reason: "Restore membership" }, "reactivate"), token)).status).toBe(200);
    const login = await send("/api/auth/sign-in/email", { email: "member@example.test", password: "organization-member-password" });
    expect(login.status).toBe(200);

    const invitations = await send("/v1/query", { queryType: "organization.invitations.list" }, token);
    const invitationView = await invitations.json() as { snapshot: OrganizationDirectorySnapshot };
    expect(invitationView.snapshot.invitations[0]?.status).toBe("accepted");
    const policy = await send("/v1/query", { queryType: "organization.auth-policy.get" }, token);
    expect((await policy.json() as { snapshot: OrganizationDirectorySnapshot }).snapshot.policy).toMatchObject({ passkeyEnabled: true, passwordEnabled: true, rateLimitStorage: "database" });
  });

  it("lists and revokes self sessions without returning session tokens", async () => {
    const { app, send, get } = await application();
    const password = "session-owner-password";
    const boot = await app.brain.bootstrap({ organizationId: "org-sessions", name: "Sessions", email: "sessions@example.test", password }, setupCredential(app.brain));
    const second = await send("/api/auth/sign-in/email", { email: "sessions@example.test", password });
    const secondAccount = await second.json() as { token: string };
    const listed = await get("/v1/identity/sessions", boot.sessionToken);
    expect(listed.status).toBe(200);
    const sessions = (await listed.json() as { items: OrganizationSessionView[] }).items;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(boot.sessionToken);
    expect(JSON.stringify(sessions)).not.toContain(secondAccount.token);
    const other = sessions.find((session) => !session.current)!;
    expect((await send("/v1/identity/sessions/revoke", { mode: "one", sessionId: other.id }, boot.sessionToken)).status).toBe(204);
    expect((await get("/v1/identity/sessions", secondAccount.token)).status).toBe(401);
    expect((await send("/v1/identity/sessions/revoke", { mode: "others" }, boot.sessionToken)).status).toBe(204);
  });

  it("cancels and retries only eligible invitations with durable intents", async () => {
    const { app, send } = await application();
    const boot = await app.brain.bootstrap({ organizationId: "org-delivery", name: "Delivery", email: "delivery@example.test", password: "delivery-owner-password" }, setupCredential(app.brain));
    const token = boot.sessionToken;
    const first = await send("/v1/commands", command("organization.invitation.create", 1, { email: "cancel@example.test", reason: "Cancel this invitation" }, "cancel-create"), token);
    const firstId = (await first.json() as { resourceId: string }).resourceId;
    expect((await send("/v1/commands", command("organization.invitation.cancel", 2, { invitationId: firstId, reason: "Cancel delivery" }, "cancel"), token)).status).toBe(200);
    expect((await send("/v1/commands", command("organization.invitation.retry", 3, { invitationId: firstId, reason: "Invalid retry" }, "cancel-retry"), token)).status).toBe(409);
    const second = await send("/v1/commands", command("organization.invitation.create", 3, { email: "retry@example.test", reason: "Retry this invitation" }, "retry-create"), token);
    const secondId = (await second.json() as { resourceId: string }).resourceId;
    app.brain.store.control.prepare("UPDATE auth_email_outbox SET state='failed',last_error='provider unavailable' WHERE id=?").run(`invitation:${secondId}`);
    expect((await send("/v1/commands", command("organization.invitation.retry", 4, { invitationId: secondId, reason: "Retry failed delivery" }, "retry"), token)).status).toBe(200);
    expect(app.brain.store.control.prepare("SELECT state,attempt_count FROM auth_email_outbox WHERE id=?").get(`invitation:${secondId}`)).toEqual({ state: "pending", attempt_count: 0 });
    expect(app.brain.store.control.prepare("SELECT state FROM command_intents WHERE command_id='cmd-retry'").get()).toEqual({ state: "applied" });
  });

  it("scopes shared-user session administration to the selected organization", async () => {
    const { app, send } = await application();
    const password = "shared-owner-password";
    const boot = await app.brain.bootstrap({ organizationId: "org-a", name: "Org A", email: "shared@example.test", password }, setupCredential(app.brain));
    const token = boot.sessionToken;
    const invited = await send("/v1/commands", command("organization.invitation.create", 1, { email: "shared-member@example.test", reason: "Invite shared member" }, "shared-invite"), token);
    const invitationId = (await invited.json() as { resourceId: string }).resourceId;
    const signup = await send("/api/auth/sign-up/email", { email: "shared-member@example.test", password: "shared-member-password", name: "Shared Member" });
    const account = await signup.json() as { token: string; user: { id: string } };
    app.brain.store.control.prepare("UPDATE user SET emailVerified=1 WHERE id=?").run(account.user.id);
    expect((await send("/api/auth/organization/accept-invitation", { invitationId }, account.token)).status).toBe(200);
    const authOrgA = app.brain.store.control.prepare("SELECT auth_organization_id AS id FROM organizations WHERE id='org-a'").get() as { id: string };
    app.brain.store.control.prepare("UPDATE session SET activeOrganizationId=? WHERE userId=?").run(authOrgA.id, account.user.id);

    const authOrgB = "auth-org-b";
    app.brain.store.control.prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES (?,'Org B','brain-org-b',?)").run(authOrgB, Date.now());
    app.brain.store.control.prepare("INSERT INTO organizations(id,auth_organization_id) VALUES ('org-b',?)").run(authOrgB);
    for (const principalId of [boot.ownerPrincipalId, account.user.id]) {
      app.brain.store.control.prepare("INSERT INTO principals(id,organization_id,kind,auth_subject_id) VALUES (?,'org-b','human',?)").run(`${principalId}-b`, principalId);
      app.brain.store.control.prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES (?,?,?,?,?)").run(`member-b-${principalId}`, authOrgB, principalId, principalId === boot.ownerPrincipalId ? "owner" : "member", Date.now());
    }
    app.brain.store.control.prepare("INSERT INTO organization_authorizations(organization_id,principal_id,role,granted_by,granted_at_ms) VALUES ('org-b',?,'organization-admin',?,?)").run(`${boot.ownerPrincipalId}-b`, `${boot.ownerPrincipalId}-b`, Date.now());

    app.brain.store.control.prepare("UPDATE session SET activeOrganizationId=? WHERE userId=?").run(authOrgA.id, boot.ownerPrincipalId);
    expect((await send("/v1/commands", command("organization.session.revoke", 2, { principalId: account.user.id, sessionId: "not-current-org", reason: "Wrong tenant" }, "wrong-tenant"), token)).status).toBe(404);
    const orgBHeaders = { authorization: `Bearer ${token}`, "x-brain-organization-id": "org-b", "content-type": "application/json" };
    const orgBDetail = await app.fetch(new Request("http://127.0.0.1:3000/v1/query", { method: "POST", headers: orgBHeaders, body: JSON.stringify({ queryType: "organization.member.get", resourceId: `${account.user.id}-b` }) }));
    expect(orgBDetail.status).toBe(200);
    app.brain.store.control.prepare("UPDATE session SET activeOrganizationId=? WHERE userId=?").run(authOrgB, account.user.id);
    const sessionId = (app.brain.store.control.prepare("SELECT id FROM session WHERE userId=?").get(account.user.id) as { id: string }).id;
    expect((await send("/v1/commands", command("organization.session.revoke", 2, { principalId: account.user.id, sessionId, reason: "Revoke org A only" }, "org-a-revoke"), token)).status).toBe(404);
    const orgBRevoke = await app.fetch(new Request("http://127.0.0.1:3000/v1/commands", { method: "POST", headers: orgBHeaders, body: JSON.stringify(command("organization.session.revoke", 1, { principalId: `${account.user.id}-b`, sessionId, reason: "Revoke org B only" }, "org-b-revoke")) }));
    expect(orgBRevoke.status).toBe(200);
  });
});
