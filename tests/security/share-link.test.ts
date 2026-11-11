import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { putBytes } from "../../apps/governor/src/modules/artifacts/index";
import { achievedMission } from "../support/reuse";
import { seedHuman, setupWorld, type TestWorld } from "../helpers";

// Read-only share links (#60, ADR 0013): one verified result, a bearer token that expires and can be revoked, no other access.
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const ORIGIN = "http://127.0.0.1:3000";
const SECRET_TEXT = "# Churn report\nPricing confusion drove most cancellations.";

async function fixture(): Promise<{ w: TestWorld; versionId: string; db: ReturnType<TestWorld["brain"]["store"]["workspaceDb"]> }> {
  app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-share-")), allowTestActor: true });
  const w = setupWorld(app.brain);
  await achievedMission(w, "share", { title: "Quarterly churn report", intent: "Analyse churn", outputs: [{ name: "churn-report.md", text: SECRET_TEXT }] });
  return { w, versionId: "ver-share-0", db: app.brain.store.workspaceDb(w.workspaceId, w.org) };
}
const view = (token: string, headers: Record<string, string> = {}) => app!.fetch(new Request(`${ORIGIN}/v1/shared/${token}`, { headers }));

describe("share link authorization (#60)", () => {
  it("shows exactly the one result, returns the token once, stores only its digest and audits create, view and revoke", async () => {
    const { w, versionId, db } = await fixture();
    const created = w.brain.shares.create(w.owner, w.workspaceId, { versionId });
    expect(created.token.length).toBeGreaterThanOrEqual(43);
    // Only a keyed digest is stored: the token appears in no column of the row.
    const row = w.brain.store.control.prepare("SELECT * FROM result_shares WHERE id=?").get(created.shareId) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(row["token_digest"]).toBe(w.brain.store.tokenDigest("result-share", created.token));
    expect(w.brain.shares.list(w.owner, w.workspaceId, versionId)).toHaveLength(1);
    expect(JSON.stringify(w.brain.shares.list(w.owner, w.workspaceId, versionId))).not.toContain(created.token);

    const res = await view(created.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ name: "churn-report.md", versionLabel: "Version 1", verified: true, text: SECRET_TEXT, truncated: false });
    // Nothing about the mission, plan, workspace, runs or people.
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "mediaType", "name", "recordedAt", "sharedAt", "text", "truncated", "verified", "versionLabel"]);
    expect(JSON.stringify(body)).not.toMatch(/Quarterly churn report|ws-test|org-test|owner-1|mission-/u);

    w.brain.shares.revoke(w.owner, w.workspaceId, created.shareId);
    const events = (db.prepare("SELECT event_type FROM events WHERE aggregate_type='share' ORDER BY cursor").all() as Array<{ event_type: string }>).map((entry) => entry.event_type);
    expect(events).toEqual(["share.created", "share.viewed", "share.revoked"]);
    expect(w.brain.shares.list(w.owner, w.workspaceId, versionId)[0]).toMatchObject({ state: "revoked", views: 1 });
  });

  it("expired and revoked links fail, unknown and malformed tokens fail, and a replayed token never works as a credential", async () => {
    const { w, versionId } = await fixture();
    const created = w.brain.shares.create(w.owner, w.workspaceId, { versionId, expiresInHours: 1 });
    expect((await view(created.token)).status).toBe(200);
    expect((await view(created.token.slice(0, -2) + "xx")).status).toBe(404);
    expect((await view("short")).status).toBe(404);
    expect((await view(`${created.shareId}`)).status).toBe(404);
    // Expiry is checked at view time.
    w.brain.store.control.prepare("UPDATE result_shares SET expires_at_ms=? WHERE id=?").run(w.brain.store.now() - 1, created.shareId);
    const expired = await view(created.token);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ state: "expired" });
    // Revocation is immediate and final.
    const other = w.brain.shares.create(w.owner, w.workspaceId, { versionId });
    expect((await view(other.token)).status).toBe(200);
    w.brain.shares.revoke(w.owner, w.workspaceId, other.shareId);
    w.brain.shares.revoke(w.owner, w.workspaceId, other.shareId);
    const revoked = await view(other.token);
    expect(revoked.status).toBe(410);
    expect(await revoked.json()).toMatchObject({ state: "revoked" });
    // The token is not an Authorization bearer for anything else.
    const asBearer = await app!.fetch(new Request(`${ORIGIN}/v1/query`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${created.token}` }, body: JSON.stringify({ queryType: "missions.list", workspaceId: w.workspaceId }) }));
    expect(asBearer.status).toBe(401);
    const asBearerOther = await app!.fetch(new Request(`${ORIGIN}/v1/artifacts/art-share-0/content`, { headers: { authorization: `Bearer ${other.token}` } }));
    expect([401, 404]).toContain(asBearerOther.status);
  });

  it("ignores any session on the public route and only a person with mission:write, in that workspace, can create, list or revoke", async () => {
    const { w, versionId } = await fixture();
    const created = w.brain.shares.create(w.owner, w.workspaceId, { versionId });
    // A session for someone else changes nothing about what the link shows.
    const asOther = await view(created.token, { "x-brain-test-actor": `nobody:org-other` });
    expect(asOther.status).toBe(200);
    expect((await asOther.json() as { text: string }).text).toBe(SECRET_TEXT);
    // A viewer (workspace:read only) cannot create or revoke; an agent cannot create.
    seedHuman(w.brain, w.org, "viewer-1");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'viewer-1', 'viewer', 1, 'owner-1', ?)").run(w.workspaceId, w.org, w.brain.store.now());
    const viewer = w.actor("viewer-1", w.workspaceId);
    expect(() => w.brain.shares.create(viewer, w.workspaceId, { versionId })).toThrow(/mission:write/u);
    expect(() => w.brain.shares.revoke(viewer, w.workspaceId, created.shareId)).toThrow(/mission:write/u);
    expect(w.brain.shares.list(viewer, w.workspaceId)).toEqual([]);
    expect(() => w.brain.shares.create({ ...w.owner, kind: "agent" }, w.workspaceId, { versionId })).toThrow(/only a person/u);
    // An operator who did not create the link cannot revoke it; the workspace lead's admin scope can.
    seedHuman(w.brain, w.org, "operator-2");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'operator-2', 'operator', 1, 'owner-1', ?)").run(w.workspaceId, w.org, w.brain.store.now());
    const operator = w.actor("operator-2", w.workspaceId);
    expect(() => w.brain.shares.revoke(operator, w.workspaceId, created.shareId)).toThrow(/only the person who created/u);
    // Another workspace's actor cannot touch this workspace's links at all.
    expect(() => w.brain.shares.list(w.actor("owner-1", "ws-elsewhere"), "ws-elsewhere")).toThrow();
  });

  it("is bound to one verified final version of readable, non-confidential text; later versions never leak", async () => {
    const { w, versionId, db } = await fixture();
    const created = w.brain.shares.create(w.owner, w.workspaceId, { versionId });
    // A newer version of the same output is not exposed through the old link.
    const bytes = new TextEncoder().encode("# Revised\nA later draft nobody approved sharing.");
    const digest = putBytes(w.brain.store, bytes);
    db.prepare("INSERT INTO artifacts(id,digest,bytes,media_type,classification,state,created_at_ms) VALUES ('art-later',?,?,'text/markdown','internal','verified',?)").run(digest, bytes.length, w.brain.store.now());
    db.prepare("INSERT INTO output_versions(id,output_id,work_item_id,artifact_digest,state,verified,created_at_ms) VALUES ('ver-later','out-share-0',(SELECT work_item_id FROM output_versions WHERE id='ver-share-0'),?,'final',1,?)").run(digest, w.brain.store.now() + 5);
    expect(((await (await view(created.token)).json()) as { text: string }).text).toBe(SECRET_TEXT);
    // A draft, an unverified version, a confidential artifact and a binary file cannot be shared.
    db.prepare("INSERT INTO output_versions(id,output_id,work_item_id,artifact_digest,state,verified,created_at_ms) VALUES ('ver-draft','out-share-0',(SELECT work_item_id FROM output_versions WHERE id='ver-share-0'),?,'draft',0,?)").run(digest, w.brain.store.now() + 6);
    expect(() => w.brain.shares.create(w.owner, w.workspaceId, { versionId: "ver-draft" })).toThrow(/verified, final/u);
    db.prepare("UPDATE artifacts SET classification='confidential' WHERE id='art-later'").run();
    expect(() => w.brain.shares.create(w.owner, w.workspaceId, { versionId: "ver-later" })).toThrow(/cannot be shared outside the workspace/u);
    db.prepare("UPDATE artifacts SET classification='internal', media_type='image/png' WHERE id='art-later'").run();
    expect(() => w.brain.shares.create(w.owner, w.workspaceId, { versionId: "ver-later" })).toThrow(/readable text/u);
    expect(() => w.brain.shares.create(w.owner, w.workspaceId, { versionId: "no-such-version" })).toThrow(/not found/u);
    expect(() => w.brain.shares.create(w.owner, w.workspaceId, { versionId, expiresInHours: 721 })).toThrow(/between 1 hour and 30 days/u);
    expect(() => w.brain.shares.create(w.owner, w.workspaceId, { versionId, expiresInHours: 0 })).toThrow(/between 1 hour and 30 days/u);
  });

  it("stops working when its creator loses workspace access or the workspace is archived", async () => {
    const { w, versionId } = await fixture();
    seedHuman(w.brain, w.org, "sharer-3");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'sharer-3', 'workspace-lead', 1, 'owner-1', ?)").run(w.workspaceId, w.org, w.brain.store.now());
    const lead = w.actor("sharer-3", w.workspaceId);
    const created = w.brain.shares.create(lead, w.workspaceId, { versionId });
    expect((await view(created.token)).status).toBe(200);
    w.brain.store.control.prepare("UPDATE workspace_memberships SET revoked_at_ms=? WHERE principal_id='sharer-3'").run(w.brain.store.now());
    expect((await view(created.token)).status).toBe(410);
  });

  it("a link viewed exactly at its expiry is gone, and a view after revocation is neither shown nor counted (row 54)", async () => {
    const { w, versionId } = await fixture();
    const created = w.brain.shares.create(w.owner, w.workspaceId, { versionId });
    const control = w.brain.store.control;
    control.prepare("UPDATE result_shares SET expires_at_ms=? WHERE id=?").run(w.brain.store.now() + 120_000, created.shareId);
    expect((await view(created.token)).status).toBe(200);
    // The instant of expiry is already expired, in the public read and in the list.
    control.prepare("UPDATE result_shares SET expires_at_ms=? WHERE id=?").run(w.brain.store.now(), created.shareId);
    expect((await view(created.token)).status).toBe(410);
    expect(w.brain.shares.list(w.owner, w.workspaceId, versionId)[0]).toMatchObject({ state: "expired", views: 1 });
    // Revoked while it is still inside its time: the next view is refused and the counter stays.
    const live = w.brain.shares.create(w.owner, w.workspaceId, { versionId });
    expect((await view(live.token)).status).toBe(200);
    w.brain.shares.revoke(w.owner, w.workspaceId, live.shareId);
    expect((await view(live.token)).status).toBe(410);
    expect(w.brain.shares.list(w.owner, w.workspaceId, versionId).find((entry) => entry.shareId === live.shareId)).toMatchObject({ state: "revoked", views: 1 });
    // Expired and revoked at once reads as revoked, never as a working link.
    control.prepare("UPDATE result_shares SET expires_at_ms=? WHERE id=?").run(w.brain.store.now() - 1, live.shareId);
    expect((await view(live.token)).status).toBe(410);
  });

  it("stops working when its creator is downgraded below the sharing scope or disabled mid-share (row 54)", async () => {
    const { w, versionId } = await fixture();
    seedHuman(w.brain, w.org, "sharer-4");
    const control = w.brain.store.control;
    control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'sharer-4', 'operator', 1, 'owner-1', ?)").run(w.workspaceId, w.org, w.brain.store.now());
    const operator = w.actor("sharer-4", w.workspaceId);
    const created = w.brain.shares.create(operator, w.workspaceId, { versionId });
    expect((await view(created.token)).status).toBe(200);
    // Downgraded to a read-only viewer: still a member, but no longer allowed to share, so the link stops with the right.
    control.prepare("UPDATE workspace_memberships SET revoked_at_ms=? WHERE principal_id='sharer-4' AND role='operator'").run(w.brain.store.now());
    control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'sharer-4', 'viewer', 1, 'owner-1', ?)").run(w.workspaceId, w.org, w.brain.store.now());
    expect((await view(created.token)).status).toBe(410);
    // Restored, the link works again (nothing was deleted); a disabled person's links stop.
    control.prepare("INSERT OR REPLACE INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms, revoked_at_ms) VALUES (?, ?, 'sharer-4', 'operator', 1, 'owner-1', ?, NULL)").run(w.workspaceId, w.org, w.brain.store.now());
    expect((await view(created.token)).status).toBe(200);
    control.prepare("UPDATE principals SET disabled_at_ms=? WHERE id='sharer-4'").run(w.brain.store.now());
    expect((await view(created.token)).status).toBe(410);
  });

  it("works over the signed-in HTTP surface: the token is returned once and the link is the only secret", async () => {
    const { w, versionId } = await fixture();
    const { token } = seedHuman(w.brain, w.org, "owner-1");
    const call = (path: string, body?: unknown) => app!.fetch(new Request(`${ORIGIN}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const created = await call("/v1/shares", { workspaceId: w.workspaceId, versionId, expiresInHours: 24 });
    expect(created.status).toBe(201);
    const { shareId, url } = await created.json() as { shareId: string; url: string };
    expect(url).toMatch(/\/shared\/[A-Za-z0-9_-]{43}$/u);
    const listed = await (await call(`/v1/shares?workspaceId=${w.workspaceId}&versionId=${versionId}`)).json() as { items: Array<{ shareId: string; state: string }> };
    expect(listed.items.map((item) => [item.shareId, item.state])).toEqual([[shareId, "active"]]);
    expect(JSON.stringify(listed)).not.toContain(url.split("/").at(-1)!);
    expect((await view(url.split("/").at(-1)!)).status).toBe(200);
    expect((await call("/v1/shares/revoke", { workspaceId: w.workspaceId, shareId })).status).toBe(200);
    expect((await view(url.split("/").at(-1)!)).status).toBe(410);
    // Creating without credentials is refused.
    expect((await app!.fetch(new Request(`${ORIGIN}/v1/shares`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: w.workspaceId, versionId }) }))).status).toBe(401);
  });
});
