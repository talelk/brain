import { afterEach, describe, expect, it } from "vitest";
import { approvalCurrentlyUsable } from "../../apps/governor/src/modules/governance/approval-authority";
import { DIGEST_A, seedHuman, storedDigest } from "../helpers";
import { SSO_ORIGIN, ssoWorld, type SsoWorld } from "../support/sso-world";
import { totpCode } from "../support/totp";

// Row 92 (ADR 0026, amended): a person who signs in only through the company directory has no password, so the vendor's authenticator
// enrolment (which asks for one) was closed to them and, under the required second factor, so was approving effects. They may now set up
// an authenticator right after a fresh directory sign-in, and nothing else about their factor can be read, changed or removed this way.
let world: SsoWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const ann = { sub: "d-ann", email: "ann@keyrus.test", name: "Ann Approver", groups: ["brain-approvers", "brain-operators"] };
const post = (s: SsoWorld, path: string, body: unknown, cookie: string) => s.app.fetch(new Request(`${SSO_ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...s.as(cookie) }, body: JSON.stringify(body) }));
/** The cookie jar after a response that rotated the session (enrolment replaces the session). */
const merge = (cookie: string, response: Response): string => {
  const jar = new Map(cookie.split("; ").filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] as const));
  for (const line of response.headers.getSetCookie()) { const [pair = ""] = line.split(";"); const at = pair.indexOf("="); if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1)); }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
};
const subject = (s: SsoWorld, nonce: string) => ({
  organizationId: s.w.org, workspaceId: s.w.workspaceId, operation: "effect.host.restart", tool: { id: "host.restart", digest: DIGEST_A }, inputDigest: DIGEST_A,
  target: { targetId: "tool:host.restart", environmentId: "local", preconditionDigest: DIGEST_A }, artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
  effectBounds: { summary: "Restart the container demo-app", once: true }, expiresAt: new Date(Date.now() + 3600000).toISOString(), nonce,
});

async function directoryApprover() {
  const s = await ssoWorld({ requireTwoFactor: true });
  world = s;
  expect((await s.configure({ defaultRole: undefined, groupRoles: [{ group: "brain-approvers", role: "approver" }, { group: "brain-operators", role: "operator" }] })).status).toBe(200);
  const signed = await s.signIn(ann);
  expect(signed.ok, signed.location).toBe(true);
  return { s, cookie: signed.cookie };
}

describe("a directory-only person enrolls an authenticator and approves effects", () => {
  it("cannot approve before enrolling, enrolls without a password, then approves one exact effect with a code", async () => {
    const { s, cookie } = await directoryApprover();
    const ask = async (nonce: string) => {
      const subj = subject(s, nonce);
      const receipt = await (await s.command(s.ownerHeaders, "approval.request", { subject: subj }, `req-${nonce}`)).json() as { resourceId?: string };
      return { approvalId: receipt.resourceId!, digest: storedDigest(s.w.brain, receipt.resourceId!) };
    };
    const first = await ask("eff-1");
    // Required second factor and no authenticator: no step-up challenge can even be opened.
    const early = await post(s, "/v1/step-up/challenges", { approvalId: first.approvalId, subjectDigest: first.digest }, cookie);
    expect(early.status).toBeGreaterThanOrEqual(400);
    const me = await (await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/identity`, { headers: s.as(cookie) }))).json() as { totpEnrolled: boolean; requireTwoFactor: boolean };
    expect(me).toMatchObject({ totpEnrolled: false, requireTwoFactor: true });

    // Enrolment: no password in the request, the vendor's own two calls.
    const enabled = await post(s, "/api/auth/two-factor/enable", {}, cookie);
    expect(enabled.status).toBe(200);
    const { totpURI } = await enabled.json() as { totpURI: string };
    const secret = new URL(totpURI).searchParams.get("secret")!;
    const verified = await post(s, "/api/auth/two-factor/verify-totp", { code: totpCode(secret, Date.now()), trustDevice: false }, cookie);
    expect(verified.status).toBe(200);
    const enrolled = merge(cookie, verified);
    expect(enrolled).not.toBe(cookie);
    expect(((await (await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/identity`, { headers: s.as(enrolled) }))).json()) as { totpEnrolled: boolean }).totpEnrolled).toBe(true);

    const decide = (approvalId: string, digest: string, key: string, evidenceId?: string) => s.app.fetch(new Request(`${SSO_ORIGIN}/v1/approvals/${approvalId}/decision`, {
      method: "POST", headers: { "content-type": "application/json", ...s.as(enrolled) },
      body: JSON.stringify({ contractVersion: "brain.approval-decision/v1", idempotencyKey: key, decision: "approve", subjectDigest: digest, expectedVersion: 1, note: "restart it", ...(evidenceId ? { stepUpEvidenceId: evidenceId } : {}) }),
    }));
    expect((await decide(first.approvalId, first.digest, "no-proof")).status).toBeGreaterThanOrEqual(400);
    const challenge = await post(s, "/v1/step-up/challenges", { approvalId: first.approvalId, subjectDigest: first.digest }, enrolled);
    expect(challenge.status).toBe(201);
    const { challengeId, method } = await challenge.json() as { challengeId: string; method: string };
    expect(method).toBe("totp");
    expect((await post(s, "/v1/step-up/verify", { challengeId, code: "000000" }, enrolled)).status).toBe(403);
    const proof = await post(s, "/v1/step-up/verify", { challengeId, code: totpCode(secret, Date.now()) }, enrolled);
    expect(proof.status).toBe(200);
    const { evidenceId } = await proof.json() as { evidenceId: string };
    // The proof is tied to this one approval.
    const second = await ask("eff-2");
    expect((await decide(second.approvalId, second.digest, "wrong-approval", evidenceId)).status).toBeGreaterThanOrEqual(400);
    expect((await decide(first.approvalId, first.digest, "approve-eff-1", evidenceId)).status).toBe(200);
    const state = (id: string) => (s.app.brain.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(id) as { state: string }).state;
    expect(state(first.approvalId)).toBe("approved");
    // The decision is attributed to the directory person, and an effect permit may now be issued for exactly that approval.
    const principal = (s.app.brain.store.control.prepare('SELECT id FROM principals WHERE auth_subject_id=(SELECT id FROM "user" WHERE email=?)').get(ann.email) as { id: string }).id;
    expect((s.app.brain.store.control.prepare("SELECT actor_id FROM approval_decisions WHERE approval_id=?").get(first.approvalId) as { actor_id: string }).actor_id).toBe(principal);
    expect(approvalCurrentlyUsable(s.app.brain.store, s.app.brain.auth, { approvalId: first.approvalId, organizationId: s.w.org, workspaceId: s.w.workspaceId, subjectDigest: first.digest })).toBe(true);
    expect(state(second.approvalId)).toBe("pending");
    // The authenticator secret is nowhere in what Brain recorded as events.
    expect(JSON.stringify(s.app.brain.store.control.prepare("SELECT * FROM events").all())).not.toContain(secret);
  });

  it("is a second reviewer too: the person who asked cannot approve their own request even with an authenticator", async () => {
    const { s, cookie } = await directoryApprover();
    const enabled = await post(s, "/api/auth/two-factor/enable", {}, cookie);
    const secret = new URL((await enabled.json() as { totpURI: string }).totpURI).searchParams.get("secret")!;
    const enrolled = merge(cookie, await post(s, "/api/auth/two-factor/verify-totp", { code: totpCode(secret, Date.now()), trustDevice: false }, cookie));
    const subj = subject(s, "ann-own");
    const own = await (await post(s, "/v1/commands", { contractVersion: "brain.command/v1", commandId: "cmd-own", commandType: "approval.request", workspaceId: s.w.workspaceId, idempotencyKey: "own", payload: { subject: subj } }, enrolled)).json() as { resourceId?: string };
    const digest = storedDigest(s.w.brain, own.resourceId!);
    const challenge = await post(s, "/v1/step-up/challenges", { approvalId: own.resourceId, subjectDigest: digest }, enrolled);
    const { challengeId } = await challenge.json() as { challengeId: string };
    const proof = await (await post(s, "/v1/step-up/verify", { challengeId, code: totpCode(secret, Date.now()) }, enrolled)).json() as { evidenceId: string };
    const self = await post(s, `/v1/approvals/${own.resourceId}/decision`, { contractVersion: "brain.approval-decision/v1", idempotencyKey: "self", decision: "approve", subjectDigest: digest, expectedVersion: 1, note: "mine", stepUpEvidenceId: proof.evidenceId }, enrolled);
    expect(self.status).toBe(403);
    expect(JSON.stringify(await self.json())).toMatch(/separation of duties/u);
  });
});

describe("the authenticator of a directory-only person cannot be added, read or swapped by a stolen session", () => {
  it("refuses enrolment on a stale directory sign-in, and after enrolment refuses reading, regenerating, removing or re-enrolling it", async () => {
    const { s, cookie } = await directoryApprover();
    const db = s.app.brain.store.control;
    const userId = (db.prepare('SELECT id FROM "user" WHERE email=?').get(ann.email) as { id: string }).id;
    // A sign-in from hours ago is a stolen-cookie shape: it must sign in again first.
    db.prepare('UPDATE "session" SET createdAt=? WHERE userId=?').run(Date.now() - 3600_000, userId);
    expect((await post(s, "/api/auth/two-factor/enable", {}, cookie)).status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM "twoFactor" WHERE userId=?').get(userId)).toEqual({ n: 0 });
    db.prepare('UPDATE "session" SET createdAt=? WHERE userId=?').run(Date.now(), userId);
    const enabled = await post(s, "/api/auth/two-factor/enable", {}, cookie);
    expect(enabled.status).toBe(200);
    const secret = new URL((await enabled.json() as { totpURI: string }).totpURI).searchParams.get("secret")!;
    const enrolled = merge(cookie, await post(s, "/api/auth/two-factor/verify-totp", { code: totpCode(secret, Date.now()), trustDevice: false }, cookie));
    for (const path of ["/api/auth/two-factor/get-totp-uri", "/api/auth/two-factor/generate-backup-codes", "/api/auth/two-factor/disable", "/api/auth/two-factor/enable"]) {
      const refused = await post(s, path, {}, enrolled);
      expect(refused.status, path).toBeGreaterThanOrEqual(400);
      expect(await refused.text(), path).not.toContain(secret);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM "twoFactor" WHERE userId=? AND verified=1').get(userId)).toEqual({ n: 1 });
    // A guessed password changes nothing for an account that has none.
    expect((await post(s, "/api/auth/two-factor/disable", { password: "guess-a-password-12345" }, enrolled)).status).toBeGreaterThanOrEqual(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM "twoFactor" WHERE userId=? AND verified=1').get(userId)).toEqual({ n: 1 });
  });

  it("does not open passwordless enrolment to anyone else: an account not from the directory is refused, and a person with a password still has to give it", async () => {
    const s = await ssoWorld({ requireTwoFactor: true });
    world = s;
    const db = s.app.brain.store.control;
    const { token } = seedHuman(s.app.brain, s.w.org, "stray-member");
    const bearer = (value: string) => ({ "content-type": "application/json", origin: SSO_ORIGIN, authorization: `Bearer ${value}` });
    const stray = await s.app.fetch(new Request(`${SSO_ORIGIN}/api/auth/two-factor/enable`, { method: "POST", headers: bearer(token), body: "{}" }));
    expect(stray.status).toBe(403);
    db.prepare("INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES ('acct-pw','owner-1','credential','owner-1',?,?,?)").run("scrypt-placeholder-hash", Date.now(), Date.now());
    const owned = await s.app.fetch(new Request(`${SSO_ORIGIN}/api/auth/two-factor/enable`, { method: "POST", headers: bearer(s.w.ownerToken), body: "{}" }));
    expect(owned.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM "twoFactor" WHERE userId=?').get("owner-1")).toEqual({ n: 0 });
  });
});
