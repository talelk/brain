import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalSubjectDigest } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { issueMachineSession } from "../../apps/governor/src/application/authz";
import { setupCredential, setupWorld, DIGEST_A } from "../helpers";
import { totpCode } from "../support/totp";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });
async function application(requireTwoFactor = false) {
  const dir = mkdtempSync(join(tmpdir(), "brain-identity-"));
  const app = await createApp({ dataDir: dir, ...(requireTwoFactor ? { runtime: { requireTwoFactor: true, memoryUiUrl: null } } : {}) });
  cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const send = (path: string, body: unknown, token?: string, headers: Record<string, string> = {}) => app.fetch(new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body),
  }));
  return { app, dir, send };
}

async function pendingApproval() {
  const { app, send } = await application();
  const w = setupWorld(app.brain);
  const approver = await w.grantApprover("reviewer-native");
  const subject = { organizationId: w.org, workspaceId: w.workspaceId, operation: "fixture.publish", tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A, target: { targetId: "target-1", environmentId: "prod", preconditionDigest: DIGEST_A }, artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A, effectBounds: {}, expiresAt: new Date(Date.now()+3600_000).toISOString(), nonce: "native-review" };
  const { receipt } = w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "cmd-native-review", commandType: "approval.request", workspaceId: w.workspaceId, idempotencyKey: "native-review", payload: { subject } }, "native-review");
  const approvalId = receipt.resourceId!;
  const digest = approvalSubjectDigest(subject);
  const challenge = await send("/v1/step-up/challenges", { approvalId, subjectDigest: digest }, approver.token);
  expect(challenge.status).toBe(201);
  const { challengeId } = await challenge.json() as { challengeId: string };
  const verify = () => send("/v1/step-up/verify", { challengeId, code: totpCode(approver.totp, Date.now()) }, approver.token);
  const decision = (evidenceId: string) => ({ contractVersion: "brain.approval-decision/v1", idempotencyKey: "native-decision", decision: "approve", subjectDigest: digest, expectedVersion: 1, note: "  reviewed exactly\n", stepUpEvidenceId: evidenceId });
  return { app, send, w, approver, approvalId, digest, challengeId, verify, decision };
}

describe("server-verified identity and native TOTP (E001–E005/E008/E051/E060)", () => {
  it("requires a private setup credential and resumes an interrupted native bootstrap", async () => {
    const { app, send, dir } = await application();
    const body = { organizationId: "org-native", name: "Native", email: "native@example.test", password: "native-test-password-123" };
    expect((await send("/v1/setup", body)).status).toBe(403);
    const credential = setupCredential(app.brain);
    expect((await send("/v1/setup", body, undefined, { authorization: `Setup ${credential}`, origin: "https://evil.example" })).status).toBe(403);
    const original = app.brain.auth.bootstrapOrganization.bind(app.brain.auth);
    const failure = vi.spyOn(app.brain.auth, "bootstrapOrganization").mockRejectedValueOnce(new Error("injected bootstrap fault"));
    const first = await send("/v1/setup", body, undefined, { authorization: `Setup ${credential}` });
    expect(first.status).toBe(500);
    expect(await first.text()).not.toContain("injected bootstrap fault");
    expect(app.brain.store.control.prepare('SELECT COUNT(*) AS n FROM "user"').get()).toEqual({ n: 1 });
    failure.mockImplementation(original);
    const response = await send("/v1/setup", body, undefined, { authorization: `Setup ${credential}` });
    expect(response.status).toBe(201);
    const result = await response.json() as { sessionToken: string; ownerPrincipalId: string; organizationId: string };
    expect(existsSync(join(dir, "setup.token"))).toBe(false);
    expect(app.brain.store.control.prepare('SELECT COUNT(*) AS n FROM "user"').get()).toEqual({ n: 1 });
    const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const identity = await app.brain.resolveActor(new Headers({ cookie }));
    expect(identity.actor.actorId).toBe(result.ownerPrincipalId);
    expect(identity.actor.organizationId).toBe(result.organizationId);
    expect(identity.sessionDigest).toBe(app.brain.store.tokenDigest("auth-session", identity.humanSession!.sessionId));
    expect(identity.humanSession!.factorDigest).toBeNull();
    expect((await send("/v1/setup", body, undefined, { authorization: `Setup ${credential}` })).status).toBe(409);
    await expect(app.brain.resolveActor(new Headers({ cookie, authorization: "Bearer invalid-explicit-token" }))).rejects.toThrow();
  });

  it("enrolls and verifies TOTP through the pinned vendor and invalidates the replaced session", async () => {
    const { app, send } = await application();
    const password = "native-enrollment-password";
    const boot = await app.brain.bootstrap({ organizationId: "org-enroll", name: "Enroll", email: "enroll@example.test", password }, setupCredential(app.brain));
    const before = await app.brain.resolveActor(new Headers({ authorization: `Bearer ${boot.sessionToken}` }));
    const enabled = await send("/api/auth/two-factor/enable", { password }, boot.sessionToken);
    expect(enabled.status).toBe(200);
    const { totpURI, backupCodes } = await enabled.json() as { totpURI: string; backupCodes: string[] };
    const secret = new URL(totpURI).searchParams.get("secret")!;
    const enrolled = await send("/api/auth/two-factor/verify-totp", { code: totpCode(secret, Date.now()), trustDevice: false }, boot.sessionToken);
    expect(enrolled.status).toBe(200);
    // In this pinned release enrollment rotates the session cookie while the
    // JSON response still names the previous token. Consume the bearer plugin's
    // actual new cookie token; never treat the JSON field as session authority.
    const token = enrolled.headers.get("set-auth-token")!;
    expect(token).toBeTruthy();
    expect(enrolled.headers.get("set-cookie") ?? "").not.toContain("trust_device");
    await expect(app.brain.resolveActor(new Headers({ authorization: `Bearer ${boot.sessionToken}` }))).rejects.toThrow();
    const after = await app.brain.resolveActor(new Headers({ authorization: `Bearer ${token}` }));
    expect(after.humanSession!.sessionId).not.toBe(before.humanSession!.sessionId);
    expect(after.humanSession!.factorDigest).toMatch(/^sha256:/u);
    const row = app.brain.store.control.prepare('SELECT secret FROM "twoFactor" WHERE userId=?').get(after.humanSession!.userId) as { secret: string };
    expect(row.secret).not.toContain(secret);
    expect(await app.brain.auth.verifyTotp(new Headers({ authorization: `Bearer ${token}` }), totpCode(secret, Date.now()))).toBe(true);
    expect(app.brain.store.control.prepare("SELECT 1 FROM sqlite_master WHERE name='totp_secrets'").get()).toBeUndefined();
    const login = await send("/api/auth/sign-in/email", { email: "enroll@example.test", password });
    expect(await login.json()).toMatchObject({ twoFactorRedirect: true });
    const challengeCookie=login.headers.getSetCookie().map((c)=>c.split(";")[0]).join("; ");
    const recovered=await send("/api/auth/two-factor/verify-backup-code",{code:backupCodes[0],trustDevice:false},undefined,{cookie:challengeCookie,origin:"http://127.0.0.1:3000"});
    expect(recovered.status).toBe(200);
    const recoveredToken=recovered.headers.get("set-auth-token")!;
    const recoveredHeaders=new Headers({authorization:`Bearer ${recoveredToken}`});
    const recoveredIdentity=await app.brain.resolveActor(recoveredHeaders);
    expect(recoveredIdentity.humanSession).toMatchObject({recoveryRequired:true,factorDigest:null});
    expect(await app.brain.auth.verifyTotp(recoveredHeaders,totpCode(secret,Date.now()))).toBe(false);
    const disabled=await send("/api/auth/two-factor/disable",{password},recoveredToken);expect(disabled.status).toBe(200);
    const replacementToken=disabled.headers.get("set-auth-token")!;
    const replacement=await send("/api/auth/two-factor/enable",{password},replacementToken);expect(replacement.status).toBe(200);
    const replacementSecret=new URL((await replacement.json() as {totpURI:string}).totpURI).searchParams.get("secret")!;
    const completed=await send("/api/auth/two-factor/verify-totp",{code:totpCode(replacementSecret,Date.now()),trustDevice:false},replacementToken);expect(completed.status).toBe(200);
    const completedIdentity=await app.brain.resolveActor(new Headers({authorization:`Bearer ${completed.headers.get("set-auth-token")!}`}));
    expect(completedIdentity.humanSession!.factorDigest).toBeTruthy();expect(completedIdentity.humanSession!.recoveryRequired).toBe(false);
  });

  it("rechecks native organization membership and does not reinterpret machine actors as humans", async () => {
    const { app, send } = await application(); const w = setupWorld(app.brain);
    const headers = new Headers({ authorization: `Bearer ${w.ownerToken}` });
    expect((await app.brain.resolveActor(headers)).actor.kind).toBe("human");
    app.brain.store.control.prepare("UPDATE principals SET disabled_at_ms=? WHERE id=?").run(Date.now(),w.owner.actorId);
    await expect(app.brain.resolveActor(headers)).rejects.toThrow();
    app.brain.store.control.prepare("UPDATE principals SET disabled_at_ms=NULL WHERE id=?").run(w.owner.actorId);
    expect((await app.brain.resolveActor(headers)).actor.kind).toBe("human");
    expect(() => issueMachineSession(app.brain.store, w.owner.actorId, w.org)).toThrow(/machine/);
    app.brain.ensurePrincipal(w.org, "workflow-machine", "workflow");
    const token = issueMachineSession(app.brain.store, "workflow-machine", w.org);
    const identity = await app.brain.resolveActor(new Headers({ authorization: `Bearer ${token}` }));
    expect(identity.actor.kind).toBe("workflow"); expect(identity.humanSession).toBeNull();
    for(const path of ["/runner/v1/enroll","/runner/v1/challenges","/runner/v1/hello"]) expect((await send(path,{},undefined,{cookie:"better-auth.session_token=browser"})).status).toBe(401);
    expect(() => app.brain.stepUp.createChallenge(identity, "unknown", DIGEST_A)).toThrow(/human/);
    app.brain.store.control.prepare('DELETE FROM "member" WHERE userId=?').run(w.owner.actorId);
    await expect(app.brain.resolveActor(headers)).rejects.toThrow(/membership/);
  });

  it("verifies a logged-in TOTP and binds one evidence record to the exact decision", async () => {
    const x = await pendingApproval();
    const response = await x.verify(); expect(response.status).toBe(200);
    const { evidenceId } = await response.json() as { evidenceId: string };
    const decided = await x.send(`/v1/approvals/${x.approvalId}/decision`, x.decision(evidenceId), x.approver.token);
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({ state: "approved" });
    const row = x.app.brain.store.control.prepare("SELECT note FROM approval_decisions WHERE approval_id=?").get(x.approvalId) as { note: string };
    expect(row.note).toBe("  reviewed exactly\n");
    const replay = await x.send(`/v1/approvals/${x.approvalId}/decision`, x.decision(evidenceId), x.approver.token);
    expect(replay.status).toBe(200);
    expect((await x.verify()).status).toBe(409);
    expect(x.app.brain.store.control.prepare("SELECT COUNT(*) AS n FROM step_up_evidence").get()).toEqual({ n: 1 });
  });

  it("bounds wrong codes and never creates evidence from a client assertion", async () => {
    const x = await pendingApproval();
    expect((await x.send("/v1/step-up/verify", { challengeId: x.challengeId, code: totpCode(x.approver.totp, Date.now()), verified: true }, x.approver.token)).status).toBe(422);
    const validCodes = new Set([-30_000,0,30_000].map((offset) => totpCode(x.approver.totp, Date.now()+offset)));
    let wrongCode = "000000";
    for (let n=0;validCodes.has(wrongCode);n++) wrongCode = String(n+1).padStart(6,"0");
    for (let i=0;i<5;i++) expect((await x.send("/v1/step-up/verify", { challengeId: x.challengeId, code: wrongCode }, x.approver.token)).status).toBe(403);
    expect((await x.verify()).status).toBe(429);
    expect(x.app.brain.store.control.prepare("SELECT COUNT(*) AS n FROM step_up_evidence").get()).toEqual({ n: 0 });
  });

  it("accepts only one of two concurrent verifications", async () => {
    const x = await pendingApproval();
    const results = await Promise.all([x.verify(), x.verify()]);
    expect(results.map((r) => r.status).sort()).toEqual([200,409]);
    expect(x.app.brain.store.control.prepare("SELECT COUNT(*) AS n FROM step_up_evidence").get()).toEqual({ n: 1 });
  });

  it("fails closed when a session is revoked during vendor verification", async () => {
    const x = await pendingApproval();
    let markVerified!: () => void; let allowResume!: () => void;
    const verified = new Promise<void>((resolve) => { markVerified = resolve; });
    const resume = new Promise<void>((resolve) => { allowResume = resolve; });
    const real = x.app.brain.auth.verifyTotp.bind(x.app.brain.auth);
    vi.spyOn(x.app.brain.auth, "verifyTotp").mockImplementation(async (...args) => { const result = await real(...args); markVerified(); await resume; return result; });
    const request = x.verify(); await verified;
    x.app.brain.store.control.prepare('DELETE FROM "session" WHERE id=?').run(x.approver.identity.humanSession!.sessionId);
    allowResume();
    expect((await request).status).toBe(401);
    expect(x.app.brain.store.control.prepare("SELECT COUNT(*) AS n FROM step_up_evidence").get()).toEqual({ n: 0 });
  });

  it("invalidates evidence after factor disablement or membership changes", async () => {
    const x = await pendingApproval();
    const response = await x.verify(); const { evidenceId } = await response.json() as { evidenceId: string };
    x.app.brain.store.control.prepare('UPDATE "user" SET twoFactorEnabled=0 WHERE id=?').run(x.approver.identity.humanSession!.userId);
    expect((await x.send(`/v1/approvals/${x.approvalId}/decision`, x.decision(evidenceId), x.approver.token)).status).toBe(403);
    expect(x.app.brain.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(x.approvalId)).toEqual({ state: "pending" });
    x.app.brain.store.control.prepare('UPDATE "user" SET twoFactorEnabled=1 WHERE id=?').run(x.approver.identity.humanSession!.userId);
    x.app.brain.store.control.prepare("UPDATE organizations SET revocation_generation=revocation_generation+1 WHERE id=?").run(x.w.org);
    expect((await x.send(`/v1/approvals/${x.approvalId}/decision`, x.decision(evidenceId), x.approver.token)).status).toBe(403);
  });

  it("invitations land in the durable outbox and accept only for the invited account; password change rotates credentials (T05/T47)", async () => {
    const { app, send } = await application();
    const password = "native-invite-password-1";
    const boot = await app.brain.bootstrap({ organizationId: "org-invite", name: "Invite", email: "owner-invite@example.test", password }, setupCredential(app.brain));
    const authOrg = app.brain.store.control.prepare('SELECT id FROM "organization" LIMIT 1').get() as { id: string };
    expect((await send("/api/auth/organization/invite-member", { email: "invitee@example.test", role: "member", organizationId: authOrg.id }, boot.sessionToken)).status).toBe(403);
    const invite = await send("/v1/commands", { contractVersion: "brain.command/v1", commandId: "invite-native-1", commandType: "organization.invitation.create", idempotencyKey: "invite-native-1", expectedVersion: 1, payload: { email: "invitee@example.test", reason: "Native invitation test" } }, boot.sessionToken);
    expect(invite.status).toBe(200);
    const invitation = await invite.json() as { resourceId: string };
    const outbox = app.brain.store.control.prepare("SELECT email,kind,state FROM auth_email_outbox WHERE id=?").get(`invitation:${invitation.resourceId}`) as { email: string; kind: string; state: string };
    expect(outbox).toEqual({ email: "invitee@example.test", kind: "organization-invitation", state: "pending" });
    // Uninvited sign-up is closed; a different invited account cannot accept this invitation.
    expect((await send("/api/auth/sign-up/email", { email: "stranger@example.test", password: "other-password-1234", name: "Stranger" })).status).toBe(403);
    await send("/v1/commands", { contractVersion: "brain.command/v1", commandId: "invite-native-2", commandType: "organization.invitation.create", idempotencyKey: "invite-native-2", expectedVersion: 2, payload: { email: "other@example.test", reason: "Second invitation test" } }, boot.sessionToken);
    const other = await send("/api/auth/sign-up/email", { email: "other@example.test", password: "other-password-1234", name: "Other" });
    const otherBody = await other.json() as { token?: string; user?: { id: string } };
    app.brain.store.control.prepare('UPDATE "user" SET emailVerified=1 WHERE id=?').run(otherBody.user!.id);
    const wrongAccept = await send("/api/auth/organization/accept-invitation", { invitationId: invitation.resourceId }, otherBody.token);
    expect(wrongAccept.status).not.toBe(200);
    // The invited account verifies its email, accepts and becomes a member.
    const signup = await send("/api/auth/sign-up/email", { email: "invitee@example.test", password: "invitee-password-123", name: "Invitee" });
    expect(signup.status).toBe(200);
    const inviteeBody = await signup.json() as { token?: string; user?: { id: string } };
    const verification = app.brain.store.control.prepare("SELECT url FROM auth_email_outbox WHERE kind='verify-email' AND email=? ORDER BY created_at_ms DESC LIMIT 1").get("invitee@example.test") as { url: string };
    expect(new URL(verification.url).searchParams.get("callbackURL")).toBe(`/accept-invitation/${invitation.resourceId}`);
    const verified = await app.fetch(new Request(verification.url, { redirect: "manual" }));
    expect(verified.status).toBeLessThan(400);
    const accepted = await send("/api/auth/organization/accept-invitation", { invitationId: invitation.resourceId }, inviteeBody.token);
    expect(accepted.status).toBe(200);
    expect(app.brain.auth.hasMembership(inviteeBody.user!.id, authOrg.id)).toBe(true);
    // Password rotation: old password stops working, new one signs in.
    const changed = await send("/api/auth/change-password", { currentPassword: password, newPassword: "native-invite-password-2", revokeOtherSessions: true }, boot.sessionToken);
    expect(changed.status).toBe(200);
    expect((await send("/api/auth/sign-in/email", { email: "owner-invite@example.test", password })).status).not.toBe(200);
    expect((await send("/api/auth/sign-in/email", { email: "owner-invite@example.test", password: "native-invite-password-2" })).status).toBe(200);
    // Foreign origins are not trusted for cookie-authenticated mutations.
    const cookie = boot.cookies.map((c) => c.split(";")[0]).join("; ");
    expect((await send("/api/auth/sign-out", {}, undefined, { cookie, origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("generated administrator credentials", () => {
  it("restricts temporary-password sessions until a genuinely different password is saved", async () => {
    const { app, send } = await application();
    const initial = "temporary-password-for-test-123";
    const response = await send("/v1/setup", { email: "admin@brain.local", password: initial, name: "My organization", organizationId: "org-default" }, undefined, { authorization: `Setup ${setupCredential(app.brain)}` });
    expect(response.status).toBe(201);
    const result = await response.json() as { sessionToken: string; ownerPrincipalId: string };
    app.brain.store.control.prepare("INSERT INTO brain_initial_password SELECT userId,password FROM account WHERE userId=? AND providerId='credential'").run(result.ownerPrincipalId);
    const identity = await app.fetch(new Request("http://127.0.0.1:3000/v1/identity", { headers: { authorization: `Bearer ${result.sessionToken}` } }));
    expect((await identity.json() as { passwordChangeRequired: boolean }).passwordChangeRequired).toBe(true);
    expect((await send("/v1/setup/workspace", { workspaceId: "blocked", slug: "Blocked" }, result.sessionToken)).status).toBe(403);
    expect((await send("/api/auth/change-password", { currentPassword: initial, newPassword: initial }, result.sessionToken)).status).toBe(400);
    const changed = await send("/api/auth/change-password", { currentPassword: initial, newPassword: "new-unique-password-for-test-456", revokeOtherSessions: true }, result.sessionToken);
    expect(changed.status).toBe(200);
    const login = await send("/api/auth/sign-in/email", { email: "admin@brain.local", password: "new-unique-password-for-test-456" });
    expect(login.status).toBe(200);
    const account = await login.json() as { token: string };
    expect((await app.brain.auth.readSession(new Headers({ authorization: `Bearer ${account.token}` })))?.passwordChangeRequired).toBe(false);
    expect((await send("/v1/setup/workspace", { workspaceId: "allowed", slug: "Allowed" }, account.token)).status).toBe(201);
    expect((await send("/api/auth/sign-in/email", { email: "admin@brain.local", password: initial })).status).toBe(401);
  });
});

it("required 2FA gates both runner-token issuance and guided local pairing", async () => {
  const { app, send } = await application(true);
  const password = "required-factor-password-123";
  const setup = await send("/v1/setup", { email: "factor@example.test", password, name: "Required factor", organizationId: "org-factor" }, undefined, { authorization: `Setup ${setupCredential(app.brain)}` });
  expect(setup.status).toBe(201);
  const boot = await setup.json() as { sessionToken: string };
  expect((await send("/v1/runner-tokens", { groupId: "agents" }, boot.sessionToken)).status).toBe(403);
  expect((await send("/v1/local-runtime/connect", { modelUrl: "http://localhost:8000/v1", modelId: "model" }, boot.sessionToken)).status).toBe(403);
  const enabled = await send("/api/auth/two-factor/enable", { password }, boot.sessionToken);
  const secret = new URL((await enabled.json() as { totpURI: string }).totpURI).searchParams.get("secret")!;
  const verified = await send("/api/auth/two-factor/verify-totp", { code: totpCode(secret, Date.now()), trustDevice: false }, boot.sessionToken);
  expect(verified.status).toBe(200);
  expect((await send("/v1/runner-tokens", { groupId: "agents" }, verified.headers.get("set-auth-token")!)).status).toBe(201);
});
