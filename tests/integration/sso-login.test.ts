import { afterEach, describe, expect, it } from "vitest";
import { seedHuman, seedOrganization } from "../helpers";
import { SSO_CLIENT_SECRET, SSO_ORIGIN, ssoWorld, type SsoWorld } from "../support/sso-world";

// Single sign-on with a company directory (ADR 0026), end to end against a local fake OpenID Connect provider: discovery, authorization
// code with PKCE, a signed ID token, first-login provisioning by default role or group, and refusals that leave no account behind.
let world: SsoWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const alice = { sub: "dir-alice", email: "alice@keyrus.test", name: "Alice Analyst", groups: ["brain-analysts"] };
const roles = (s: SsoWorld, userId: string) => (s.app.brain.store.control.prepare("SELECT workspace_id AS ws, role FROM workspace_memberships WHERE principal_id=? AND revoked_at_ms IS NULL ORDER BY role").all(userId) as Array<{ ws: string; role: string }>).map((row) => row.role);
const userRows = (s: SsoWorld, email: string) => (s.app.brain.store.control.prepare('SELECT COUNT(*) AS n FROM "user" WHERE email=?').get(email) as { n: number }).n;
const identity = async (s: SsoWorld, cookie: string) => (await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/identity`, { headers: s.as(cookie) })));

describe("single sign-on with the company directory (OIDC, PKCE)", () => {
  it("is set in Administration with a secret reference and never shows the secret", async () => {
    world = await ssoWorld();
    const s = world;
    expect((await (await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/auth/providers`))).json())).toEqual({ password: true, sso: null });
    // A person without the identity security scope cannot set it.
    const operator = await s.w.grantApprover("not-an-admin");
    const refused = await s.command({ "x-brain-test-actor": `${operator.actor.actorId}:${s.w.org}` }, "identity.oidc.set", { enabled: true, issuer: s.idp.issuer, clientId: "x", secretRef: `file:${s.secretFile}`, autoProvision: false });
    expect(refused.status).toBe(403);
    // The secret must resolve and the file must be private; a plain-text secret in the setting is refused by the contract.
    expect((await s.configure({ secretRef: "file:/no/such/secret" })).status).toBe(422);
    expect((await s.configure({ secretRef: "plain-secret-value" })).status).toBe(422);
    expect((await s.configure({ issuer: "http://idp.example.com" })).status).toBe(422);
    // A setting cannot reach the Governor's own keys or environment: the secret goes to the directory's token endpoint.
    expect((await s.configure({ secretRef: `file:${s.app.brain.store.dataDir}/authority.keys` })).status).toBe(422);
    expect((await s.configure({ secretRef: "env:BRAIN_AUTH_SECRET" })).status).toBe(422);
    const saved = await s.configure({ groupRoles: [{ group: "brain-approvers", role: "approver" }] });
    expect(saved.status).toBe(200);
    const view = await (await s.query(s.ownerHeaders, { queryType: "identity.oidc.get" })).json() as { snapshot: Record<string, unknown> };
    expect(view.snapshot).toMatchObject({ configured: true, enabled: true, issuer: s.idp.issuer, secretRef: `file:${s.secretFile}`, secretReadable: true, autoProvision: true, defaultRole: "operator", redirectUri: "http://localhost:3000/api/auth/callback/brain-oidc" });
    expect(JSON.stringify(view)).not.toContain(SSO_CLIENT_SECRET);
    expect((await (await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/auth/providers`))).json())).toMatchObject({ password: true, sso: { providerId: "brain-oidc" } });
    // Only identity readers may read the setting.
    const reader = await s.query({ "x-brain-test-actor": `${operator.actor.actorId}:${s.w.org}` }, { queryType: "identity.oidc.get" });
    expect(reader.status).toBe(403);
  });

  it("signs a new person in through the directory and provisions them into the default role, with PKCE and the secret really used", async () => {
    world = await ssoWorld();
    const s = world;
    await s.configure();
    expect(userRows(s, alice.email)).toBe(0);
    const result = await s.signIn(alice);
    expect(result.ok, result.location).toBe(true);
    expect(result.location).toContain("/today");
    // The authorization request carried PKCE S256, a state and a nonce; the token request was authenticated and proved the verifier.
    expect(s.idp.authorizeRequests[0]).toMatchObject({ response_type: "code", code_challenge_method: "S256" });
    expect(s.idp.authorizeRequests[0]!["code_challenge"]!.length).toBeGreaterThan(30);
    expect(s.idp.authorizeRequests[0]!["nonce"]!.length).toBeGreaterThan(8);
    expect(s.idp.tokenRequests).toHaveLength(1);
    expect(s.idp.tokenRequests[0]).toMatchObject({ pkceOk: true });
    // The new person is a real principal with exactly the configured role in the configured workspace.
    const me = await identity(s, result.cookie);
    expect(me.status).toBe(200);
    const body = await me.json() as { displayName: string; actor: { kind: string; organizationId: string }; workspaces: Array<{ workspaceId: string }> };
    expect(body.displayName).toBe("Alice Analyst");
    expect(body.actor).toMatchObject({ kind: "human", organizationId: s.w.org });
    expect(body.workspaces.map((entry) => entry.workspaceId)).toEqual([s.w.workspaceId]);
    const principalId = (s.app.brain.store.control.prepare('SELECT id FROM principals WHERE auth_subject_id=(SELECT id FROM "user" WHERE email=?)').get(alice.email) as { id: string }).id;
    expect(roles(s, principalId)).toEqual(["operator"]);
    // A second sign-in reuses the account: nothing is created twice and no role is rewritten.
    s.app.brain.store.control.prepare("UPDATE workspace_memberships SET revoked_at_ms=? WHERE principal_id=?").run(Date.now(), principalId);
    expect((await s.signIn(alice)).ok).toBe(true);
    expect(userRows(s, alice.email)).toBe(1);
    expect(roles(s, principalId)).toEqual([]);
    // The secret is nowhere in what Brain stored or returned.
    for (const table of ["identity_provider", "identity_provisionings", "events", "account"]) {
      expect(JSON.stringify(s.app.brain.store.control.prepare(`SELECT * FROM ${table}`).all())).not.toContain(SSO_CLIENT_SECRET);
    }
  });

  it("maps a group claim to roles, falls back to the default role, and refuses unmatched or unverified people before any account exists", async () => {
    world = await ssoWorld();
    const s = world;
    await s.configure({ defaultRole: undefined, groupRoles: [{ group: "brain-approvers", role: "approver" }, { group: "brain-operators", role: "operator" }], allowedDomains: ["keyrus.test"] });
    const approver = await s.signIn({ sub: "dir-ann", email: "ann@keyrus.test", name: "Ann Approver", groups: ["staff", "brain-approvers"] });
    expect(approver.ok, approver.location).toBe(true);
    const both = await s.signIn({ sub: "dir-bo", email: "bo@keyrus.test", name: "Bo Both", groups: ["brain-approvers", "brain-operators"] });
    expect(both.ok).toBe(true);
    const idOf = (email: string) => (s.app.brain.store.control.prepare('SELECT id FROM "user" WHERE email=?').get(email) as { id: string }).id;
    expect(roles(s, idOf("ann@keyrus.test"))).toEqual(["approver"]);
    expect(roles(s, idOf("bo@keyrus.test"))).toEqual(["approver", "operator"]);
    // No matching group and no default role: refused, and no user row exists afterwards.
    const stranger = await s.signIn({ sub: "dir-cy", email: "cy@keyrus.test", name: "Cy Nogroup", groups: ["staff"] });
    expect(stranger.ok).toBe(false);
    expect(stranger.location).toContain("error=");
    expect(userRows(s, "cy@keyrus.test")).toBe(0);
    // An unverified email, and a domain outside the allow-list, are refused too.
    expect((await s.signIn({ sub: "dir-di", email: "di@keyrus.test", name: "Di Unverified", groups: ["brain-operators"], emailVerified: false })).ok).toBe(false);
    expect(userRows(s, "di@keyrus.test")).toBe(0);
    expect((await s.signIn({ sub: "dir-ed", email: "ed@elsewhere.test", name: "Ed Outsider", groups: ["brain-operators"] })).ok).toBe(false);
    expect(userRows(s, "ed@elsewhere.test")).toBe(0);
    // A claim named differently is read from the configured claim and a nested path.
    await s.configure({ defaultRole: undefined, groupClaim: "groups", groupRoles: [{ group: "brain-viewers", role: "viewer" }] });
    const viewer = await s.signIn({ sub: "dir-fay", email: "fay@keyrus.test", name: "Fay Viewer", groups: ["brain-viewers"] });
    expect(viewer.ok).toBe(true);
    expect(roles(s, idOf("fay@keyrus.test"))).toEqual(["viewer"]);
  });

  it("does not create people when provisioning is off, but an existing verified member signs in through the directory", async () => {
    world = await ssoWorld();
    const s = world;
    await s.configure({ autoProvision: false, defaultRole: undefined });
    expect((await s.signIn({ sub: "dir-new", email: "newbie@keyrus.test", name: "Newbie" })).ok).toBe(false);
    expect(userRows(s, "newbie@keyrus.test")).toBe(0);
    // An invited, already verified member: the directory identity links to the same account and the same principal and roles.
    seedHuman(s.app.brain, s.w.org, "member-5");
    s.app.brain.store.control.prepare('UPDATE "user" SET emailVerified=1 WHERE id=?').run("member-5");
    s.app.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?,?,?,?,1,'owner-1',?)").run(s.w.workspaceId, s.w.org, "member-5", "viewer", Date.now());
    const result = await s.signIn({ sub: "dir-member-5", email: "member-5@fixture.test", name: "Member Five" });
    expect(result.ok, result.location).toBe(true);
    const me = await (await identity(s, result.cookie)).json() as { actor: { actorId: string } };
    expect(me.actor.actorId).toBe("member-5");
    expect(userRows(s, "member-5@fixture.test")).toBe(1);
  });

  it("stops at once when single sign-on is switched off, and a directory that is down fails closed", async () => {
    world = await ssoWorld();
    const s = world;
    await s.configure();
    expect((await s.signIn(alice)).ok).toBe(true);
    expect((await s.configure({ enabled: false })).status).toBe(200);
    expect((await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/auth/sso/start`))).status).toBe(404);
    expect((await s.signIn(alice)).ok).toBe(false);
    expect((await (await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/auth/providers`))).json())).toEqual({ password: true, sso: null });
    // Switched on again but the directory is gone: no session is minted.
    await s.configure();
    await s.idp.close();
    const down = await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/auth/sso/start`));
    expect(down.status).not.toBe(302);
    world = undefined;
    await s.close();
  });

  it("never signs a person in to an organization that does not own the setting: another organization's member cannot be reached through this directory", async () => {
    world = await ssoWorld();
    const s = world;
    // The administrator of org-test controls the directory (and its allow-list); org-b has a verified member whose email the directory can claim.
    seedOrganization(s.app.brain, { organizationId: "org-b", ownerId: "owner-b" });
    s.app.brain.store.control.prepare('UPDATE "user" SET emailVerified=1 WHERE id=?').run("owner-b");
    await s.configure();
    const attack = await s.signIn({ sub: "dir-evil", email: "owner-b@fixture.test", name: "Not Owner B" });
    expect(attack.ok).toBe(false);
    expect(attack.location).toContain("error=");
    expect(s.app.brain.store.control.prepare("SELECT COUNT(*) AS n FROM account WHERE providerId='brain-oidc'").get()).toEqual({ n: 0 });
    expect(attack.cookie).not.toContain("session_token");
    // The same refusal for a person who exists on this Governor but is not a member of the organization that owns the setting.
    s.app.brain.store.control.prepare("INSERT INTO \"user\"(id,name,email,emailVerified,createdAt,updatedAt) VALUES ('stray-1','Stray','stray@keyrus.test',1,?,?)").run(Date.now(), Date.now());
    expect((await s.signIn({ sub: "dir-stray", email: "stray@keyrus.test", name: "Stray" })).ok).toBe(false);
    expect(s.app.brain.store.control.prepare("SELECT COUNT(*) AS n FROM account WHERE providerId='brain-oidc'").get()).toEqual({ n: 0 });
  });

  it("keeps a login that is in progress working across unrelated commands, with the directory's discovery fetched once", async () => {
    world = await ssoWorld();
    const s = world;
    await s.configure();
    const result = await s.signIn(alice, async () => {
      // Unrelated commits while the person is at the directory must not drop and re-discover the provider.
      for (const key of ["a", "b", "c"]) expect((await s.command(s.ownerHeaders, "mission.create", { title: `Unrelated ${key}`, intent: "Noise", successCriteria: ["x"] }, `noise-${key}`)).status).toBe(200);
    });
    expect(result.ok, result.location).toBe(true);
    expect(s.idp.discovery.requests).toBe(1);
    // Saving a changed setting does re-register it.
    expect((await s.configure({ clientId: "brain-test-client" , groupClaim: "roles" })).status).toBe(200);
    expect((await s.signIn(alice)).ok).toBe(true);
    expect(s.idp.discovery.requests).toBe(2);
  });
});
