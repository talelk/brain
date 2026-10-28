import { describe, expect, it } from "vitest";
import { setupWorld } from "../helpers";

describe("security authz", async () => {
  it("client-supplied ActorContext is never trusted (E001)", async () => {
    const w = setupWorld();
    const headers = new Headers({ authorization: `Bearer ${w.ownerToken}`, "x-actor-context": JSON.stringify({ kind: "human", actorId: "admin", scopes: ["*"] }) });
    const resolved = await w.brain.resolveActor(headers, w.workspaceId);
    expect(resolved.actor.actorId).toBe("owner-1");
    expect(resolved.actor.scopes).not.toContain("*");
    w.brain.close();
  });

  it("revoked session is denied (E003)", async () => {
    const w = setupWorld();
    w.brain.store.control.prepare('DELETE FROM "session" WHERE token=?').run(w.ownerToken);
    const headers = new Headers({ authorization: `Bearer ${w.ownerToken}` });
    await expect(w.brain.resolveActor(headers)).rejects.toThrow();
    w.brain.close();
  });

  it("memory search never crosses organizations; revocation hides assets (E078)", async () => {
    const w = setupWorld();
    w.brain.memory.publish({ organizationId: w.org, workspaceId: w.workspaceId, sourceId: "src-1", text: "golden rollout notes" });
    const found = w.brain.memory.search(
      { contractVersion: "brain.memory/v1", queryId: "q1", scope: { organizationId: w.org, visibility: "workspace", workspaceId: w.workspaceId }, query: "golden", sourceTypes: ["wiki"], limit: 8, maxChars: 12000 },
      { organizationId: w.org, workspaceId: w.workspaceId },
    );
    expect(found.results.length).toBe(1);
    expect(() => w.brain.memory.search(
      { contractVersion: "brain.memory/v1", queryId: "q2", scope: { organizationId: "org-other", visibility: "workspace", workspaceId: w.workspaceId }, query: "golden", sourceTypes: ["wiki"], limit: 8, maxChars: 12000 },
      { organizationId: w.org, workspaceId: w.workspaceId },
    )).toThrow();
    w.brain.memory.revoke("src-1");
    const after = w.brain.memory.search(
      { contractVersion: "brain.memory/v1", queryId: "q3", scope: { organizationId: w.org, visibility: "workspace", workspaceId: w.workspaceId }, query: "golden", sourceTypes: ["wiki"], limit: 8, maxChars: 12000 },
      { organizationId: w.org, workspaceId: w.workspaceId },
    );
    expect(after.results.length).toBe(0);
    w.brain.close();
  });

  it("author attempt cannot accept its own verdict (E073)", async () => {
    const w = setupWorld();
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES ('sha256:bbbb','b1','job-1','att-author','submitted','{}',0)").run();
    expect(() => w.brain.acceptVerdict({runnerId:"x",epoch:1,organizationId:w.org},w.workspaceId,{
      organizationId: w.org, workspaceId: w.workspaceId, bundleDigest: "sha256:bbbb",
      evaluatorAttemptId: "att-author", evaluatorDigest: "sha256:bbbb", outcome: "verified", checks: [], acceptedBy: "x",
    })).toThrow();
    w.brain.close();
  });
});
