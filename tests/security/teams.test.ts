import { afterEach, describe, expect, it } from "vitest";
import { approvalSubjectDigest } from "@brain/contracts";
import type { JsonValue } from "@brain/contracts";
import { DIGEST_A, stepUp } from "../helpers";
import { achievedMission } from "../support/reuse";
import { SSO_ORIGIN, ssoWorld, type SsoWorld } from "../support/sso-world";

// Teams (Phase 4): several real people, each signed in through the company directory with their own session cookie, prove that roles,
// the second reviewer and read-only share links hold at the HTTP boundary, not only in the domain code.
let world: SsoWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const people = {
  lena: { sub: "d-lena", email: "lena@keyrus.test", name: "Lena Lead", groups: ["brain-leads"] },
  omar: { sub: "d-omar", email: "omar@keyrus.test", name: "Omar Operator", groups: ["brain-operators"] },
  vera: { sub: "d-vera", email: "vera@keyrus.test", name: "Vera Viewer", groups: ["brain-viewers"] },
  ann: { sub: "d-ann", email: "ann@keyrus.test", name: "Ann Approver", groups: ["brain-approvers", "brain-operators"] },
};

async function team(): Promise<{ s: SsoWorld; cookies: Record<keyof typeof people, string> }> {
  const s = await ssoWorld();
  world = s;
  expect((await s.configure({ defaultRole: undefined, groupRoles: [
    { group: "brain-leads", role: "workspace-lead" }, { group: "brain-operators", role: "operator" }, { group: "brain-viewers", role: "viewer" }, { group: "brain-approvers", role: "approver" },
  ] })).status).toBe(200);
  const cookies = {} as Record<keyof typeof people, string>;
  for (const [name, user] of Object.entries(people)) {
    const result = await s.signIn(user);
    expect(result.ok, `${name}: ${result.location}`).toBe(true);
    cookies[name as keyof typeof people] = result.cookie;
  }
  return { s, cookies };
}

const subject = (s: SsoWorld, nonce: string) => ({
  organizationId: s.w.org, workspaceId: s.w.workspaceId, operation: "fixture.publish", tool: { id: "fixture.echo", digest: DIGEST_A }, inputDigest: DIGEST_A,
  target: { targetId: "t-team", environmentId: "prod", preconditionDigest: DIGEST_A }, artifactDigest: DIGEST_A, policyDigest: DIGEST_A, configDigest: DIGEST_A,
  effectBounds: {}, expiresAt: new Date(Date.now() + 3600000).toISOString(), nonce,
});

describe("roles hold at the HTTP boundary, for people who signed in for real", () => {
  it("gives each role exactly its scopes: viewer reads, operator writes missions, lead and approver do not administer, only the owner configures", async () => {
    const { s, cookies } = await team();
    const as = (who: keyof typeof people) => s.as(cookies[who]);
    const create = (who: keyof typeof people, key: string) => s.command(as(who), "mission.create", { title: `Mission by ${who}`, intent: "Do the work", successCriteria: ["done"] }, key);
    const list = (who: keyof typeof people) => s.query(as(who), { queryType: "missions.list", workspaceId: s.w.workspaceId });

    // Everyone in the workspace can read it; the person who only views cannot write.
    for (const who of Object.keys(people) as Array<keyof typeof people>) expect((await list(who)).status, who).toBe(200);
    expect((await create("vera", "viewer-create")).status).toBe(403);
    for (const who of ["omar", "lena", "ann"] as const) expect((await create(who, `${who}-create`)).status, who).toBe(200);
    // A signed-out request reads nothing.
    expect((await s.query({}, { queryType: "missions.list", workspaceId: s.w.workspaceId })).status).toBe(401);

    // Administration needs the administrator scopes: none of the four has them, the owner does.
    const configure = (who: Record<string, string>, key: string) => s.command(who, "runnerGroup.set", { groupId: "extra-group", hostTools: false, workspaceIds: [] }, key);
    for (const who of ["lena", "omar", "vera", "ann"] as const) expect((await configure(as(who), `cfg-${who}`)).status, who).toBe(403);
    expect((await configure(s.ownerHeaders, "cfg-owner")).status).toBe(200);
    for (const who of ["lena", "omar", "vera", "ann"] as const) {
      expect((await s.command(as(who), "identity.oidc.set", { enabled: false, issuer: s.idp.issuer, clientId: "x", secretRef: `file:${s.secretFile}`, autoProvision: false }, `sso-${who}`)).status, who).toBe(403);
      expect((await s.query(as(who), { queryType: "quality.summary" })).status, who).toBe(403);
      expect((await s.query(as(who), { queryType: "identity.oidc.get" })).status, who).toBe(403);
    }
    expect((await s.query(s.ownerHeaders, { queryType: "quality.summary" })).status).toBe(200);
    // Deciding approvals is the approver's scope alone: the operator who is not an approver cannot, and a viewer cannot even ask.
    expect((await s.command(as("vera"), "approval.request", { subject: subject(s, "vera-n") }, "vera-approval")).status).toBe(403);
    expect((await s.command(as("omar"), "approval.request", { subject: subject(s, "omar-n") }, "omar-approval")).status).toBe(200);
  });

  it("keeps people inside the workspaces they were provisioned into, and loses a person the moment they are suspended", async () => {
    const { s, cookies } = await team();
    s.app.brain.createWorkspace(s.w.owner, { workspaceId: "ws-private", slug: "private" });
    const omar = s.as(cookies.omar);
    // Provisioned into ws-test only: the other workspace does not exist for them.
    const other = await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/query`, { method: "POST", headers: { "content-type": "application/json", ...omar }, body: JSON.stringify({ queryType: "missions.list", workspaceId: "ws-private" }) }));
    expect([403, 404]).toContain(other.status);
    const write = await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/commands`, { method: "POST", headers: { "content-type": "application/json", ...omar }, body: JSON.stringify({ contractVersion: "brain.command/v1", commandId: "cmd-x", commandType: "mission.create", workspaceId: "ws-private", idempotencyKey: "private-1", payload: { title: "Nope", intent: "Nope", successCriteria: ["x"] } }) }));
    expect([403, 404]).toContain(write.status);
    expect(((await (await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/identity`, { headers: omar }))).json()) as { workspaces: Array<{ workspaceId: string }> }).workspaces.map((entry) => entry.workspaceId)).toEqual([s.w.workspaceId]);
    // Suspending the principal ends the session's authority at once.
    const principal = s.app.brain.store.control.prepare('SELECT id FROM principals WHERE auth_subject_id=(SELECT id FROM "user" WHERE email=?)').get(people.omar.email) as { id: string };
    s.app.brain.store.control.prepare("UPDATE principals SET disabled_at_ms=? WHERE id=?").run(Date.now(), principal.id);
    expect([401, 403]).toContain((await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/identity`, { headers: omar }))).status);
    expect([401, 403]).toContain((await s.query(omar, { queryType: "missions.list", workspaceId: s.w.workspaceId })).status);
  });
});

describe("a second reviewer decides sensitive actions", () => {
  it("never the requester: the person who asked cannot approve it, even with the approver role; another person with a verified second factor can", async () => {
    const { s, cookies } = await team();
    const ask = async (who: Record<string, string>, nonce: string) => {
      const subj = subject(s, nonce);
      const receipt = await (await s.command(who, "approval.request", { subject: subj }, `req-${nonce}`)).json() as { resourceId?: string };
      return { approvalId: receipt.resourceId ?? "", digest: approvalSubjectDigest(subj as unknown as JsonValue) };
    };
    const decide = (who: Record<string, string>, approvalId: string, digest: string, key: string, evidenceId?: string) => s.app.fetch(new Request(`${SSO_ORIGIN}/v1/approvals/${approvalId}/decision`, {
      method: "POST", headers: { "content-type": "application/json", ...who },
      body: JSON.stringify({ contractVersion: "brain.approval-decision/v1", idempotencyKey: key, decision: "approve", subjectDigest: digest, expectedVersion: 1, note: "reviewed", ...(evidenceId ? { stepUpEvidenceId: evidenceId } : {}) }),
    }));

    // Ann holds approver and operator: she asks for something and may not approve her own request.
    const own = await ask(s.as(cookies.ann), "ann-own");
    expect(own.approvalId).not.toBe("");
    const self = await decide(s.as(cookies.ann), own.approvalId, own.digest, "ann-self", "ev-any");
    expect(self.status).toBe(403);
    expect(JSON.stringify(await self.json())).toMatch(/separation of duties/u);
    // Omar asked; Omar cannot decide (no approver scope) and neither can the viewer.
    const asked = await ask(s.as(cookies.omar), "omar-ask");
    expect((await decide(s.as(cookies.omar), asked.approvalId, asked.digest, "omar-self", "ev-any")).status).toBe(403);
    expect((await decide(s.as(cookies.vera), asked.approvalId, asked.digest, "vera-try", "ev-any")).status).toBe(403);
    // Ann is a different person from the requester but has not proved a second factor: still refused, nothing decided.
    const noFactor = await decide(s.as(cookies.ann), asked.approvalId, asked.digest, "ann-nofactor");
    expect(noFactor.status).toBeGreaterThanOrEqual(400);
    const state = () => (s.app.brain.store.control.prepare("SELECT state FROM approval_requests WHERE id=?").get(asked.approvalId) as { state: string }).state;
    expect(state()).toBe("pending");
    // A second reviewer with a verified authenticator decides it; the decision is attributed to them, not to the requester.
    const reviewer = await s.w.grantApprover("second-reviewer");
    const evidence = await stepUp(s.w, reviewer, asked.approvalId, asked.digest);
    const approved = await decide({ authorization: `Bearer ${reviewer.token}` }, asked.approvalId, asked.digest, "second-decision", evidence);
    expect(approved.status).toBe(200);
    expect(state()).toBe("approved");
    const decision = s.app.brain.store.control.prepare("SELECT actor_id FROM approval_decisions WHERE approval_id=?").get(asked.approvalId) as { actor_id: string };
    const requester = s.app.brain.store.control.prepare("SELECT requested_by FROM approval_requests WHERE id=?").get(asked.approvalId) as { requested_by: string };
    expect(decision.actor_id).toBe("second-reviewer");
    expect(requester.requested_by).not.toBe("second-reviewer");
    // Evidence is single use: the same proof cannot decide another request.
    const next = await ask(s.as(cookies.omar), "omar-ask-2");
    expect((await decide({ authorization: `Bearer ${reviewer.token}` }, next.approvalId, next.digest, "reuse-evidence", evidence)).status).toBe(403);
  });
});

describe("read-only share links work for people who never signed in", () => {
  it("lets an operator share one verified result, shows it signed out and read-only, and stops at expiry and revocation", async () => {
    const { s, cookies } = await team();
    await achievedMission(s.w, "share", { title: "Quarterly churn report", intent: "Analyse churn", outputs: [{ name: "churn-report.md", text: "# Churn\nPricing confusion drove most cancellations." }] });
    const versionId = "ver-share-0";
    const share = (who: Record<string, string>, extra: Record<string, unknown> = {}) => s.app.fetch(new Request(`${SSO_ORIGIN}/v1/shares`, { method: "POST", headers: { "content-type": "application/json", ...who }, body: JSON.stringify({ workspaceId: s.w.workspaceId, versionId, ...extra }) }));
    // A viewer cannot create a link; the operator can.
    expect((await share(s.as(cookies.vera))).status).toBe(403);
    const created = await share(s.as(cookies.omar), { expiresInHours: 1 });
    expect(created.status).toBe(201);
    const { url, shareId } = await created.json() as { url: string; shareId: string };
    const token = url.split("/shared/")[1]!;
    // Signed out, no cookie: the page shows the one result and nothing else.
    const open = await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/shared/${token}`));
    expect(open.status).toBe(200);
    expect(open.headers.get("set-cookie")).toBeNull();
    const page = await open.json() as Record<string, unknown>;
    expect(page).toMatchObject({ name: "churn-report.md", verified: true });
    expect(JSON.stringify(page)).not.toMatch(/Quarterly churn report|ws-test|org-test|owner-1|mission-/u);
    // Read-only: no verb other than GET does anything on the link, and the token is not a credential anywhere else.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/shared/${token}`, { method, headers: { "content-type": "application/json" }, body: method === "DELETE" ? null : "{}" }));
      expect([404, 405], method).toContain(response.status);
    }
    const asBearer = await s.query({ authorization: `Bearer ${token}` }, { queryType: "missions.list", workspaceId: s.w.workspaceId });
    expect(asBearer.status).toBe(401);
    const asCommand = await s.command({ authorization: `Bearer ${token}` }, "mission.create", { title: "From a link", intent: "No", successCriteria: ["x"] });
    expect(asCommand.status).toBe(401);
    // Someone else's cookie changes nothing about what the link shows, and a viewer cannot revoke it.
    expect((await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/shared/${token}`, { headers: s.as(cookies.vera) }))).status).toBe(200);
    const revokeBy = (who: Record<string, string>) => s.app.fetch(new Request(`${SSO_ORIGIN}/v1/shares/revoke`, { method: "POST", headers: { "content-type": "application/json", ...who }, body: JSON.stringify({ workspaceId: s.w.workspaceId, shareId }) }));
    expect((await revokeBy(s.as(cookies.vera))).status).toBe(403);
    // Expiry is checked when the link is opened.
    s.app.brain.store.control.prepare("UPDATE result_shares SET expires_at_ms=? WHERE id=?").run(Date.now() - 1, shareId);
    const expired = await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/shared/${token}`));
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ state: "expired" });
    // A fresh link is revoked at once by the person who made it.
    const second = await (await share(s.as(cookies.omar))).json() as { url: string; shareId: string };
    const secondToken = second.url.split("/shared/")[1]!;
    expect((await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/shared/${secondToken}`))).status).toBe(200);
    expect((await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/shares/revoke`, { method: "POST", headers: { "content-type": "application/json", ...s.as(cookies.omar) }, body: JSON.stringify({ workspaceId: s.w.workspaceId, shareId: second.shareId }) }))).status).toBe(200);
    const revoked = await s.app.fetch(new Request(`${SSO_ORIGIN}/v1/shared/${secondToken}`));
    expect(revoked.status).toBe(410);
    expect(await revoked.json()).toMatchObject({ state: "revoked" });
  });
});
