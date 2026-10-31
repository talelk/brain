import { afterEach, describe, expect, it } from "vitest";
import type { MemoryQuery } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";

// T38 packet acceptance: memory scope mappings are enforced at read time
// with current ACLs; cross-tenant reads are indistinguishable from absence;
// secret-shaped content is refused by meaning, not by one spelling.
let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

function query(over: Partial<MemoryQuery> = {}): MemoryQuery {
  return {
    contractVersion: "brain.memory/v1", queryId: "q-1",
    scope: { organizationId: "org-test", visibility: "workspace", workspaceId: "ws-test" },
    query: "rollout", sourceTypes: ["wiki"], limit: 5, maxChars: 4000,
    ...over,
  } as MemoryQuery;
}

describe("memory ACL and scope mapping (T38)", () => {
  it("workspace assets stay in their workspace; org mismatch reads as not-found", () => {
    const w = setupWorld(); world = w;
    const brain = w.brain;
    brain.memory.publish({ organizationId: w.org, workspaceId: w.workspaceId, sourceId: "doc-1", text: "rollout plan for the workspace" });
    brain.memory.publish({ organizationId: w.org, workspaceId: "ws-other", sourceId: "doc-2", text: "rollout secret of another workspace" });
    brain.memory.publish({ organizationId: "org-elsewhere", workspaceId: null, sourceId: "doc-3", text: "rollout of another tenant" });

    const mine = brain.memory.search(query(), { organizationId: w.org, workspaceId: w.workspaceId });
    expect(mine.results.map((r) => r.sourceId)).toEqual(["doc-1"]);
    expect(mine.results[0]?.provenance).toEqual(["doc-1"]);
    expect(() => brain.memory.search(query({ scope: { organizationId: "org-elsewhere", visibility: "workspace", workspaceId: w.workspaceId } }), { organizationId: w.org, workspaceId: w.workspaceId })).toThrow(/not found/i);
  });

  it("revocation is effective at read time (current ACL, not publish-time)", () => {
    const w = setupWorld(); world = w;
    const brain = w.brain;
    brain.memory.publish({ organizationId: w.org, workspaceId: w.workspaceId, sourceId: "doc-revoked", text: "rollout to be revoked" });
    expect(brain.memory.search(query(), { organizationId: w.org, workspaceId: w.workspaceId }).results).toHaveLength(1);
    brain.memory.revoke(w.org, w.workspaceId, "doc-revoked");
    expect(brain.memory.search(query(), { organizationId: w.org, workspaceId: w.workspaceId }).results).toEqual([]);
  });

  it("secret-shaped content is refused across spellings, including unlisted variants", () => {
    const w = setupWorld(); world = w;
    const brain = w.brain;
    const samples = [
      "apiKey: abc123",
      "DB_PASSWORD=hunter2",
      "the refresh token: rt_1234567890abcdef",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "clientSecret = 'shhh'",
      "SERVICE_ACCOUNT_TOKEN=xyz",
    ];
    for (const text of samples) {
      expect(() => brain.memory.publish({ organizationId: w.org, workspaceId: w.workspaceId, sourceId: "s", text }), text).toThrow(/secret/);
    }
    // Ordinary prose mentioning passwords without assignment stays publishable.
    expect(brain.memory.publish({ organizationId: w.org, workspaceId: w.workspaceId, sourceId: "ok", text: "password policy requires rotation every 90 days" })).toBeTruthy();
  });

  it("search bounds: limit clamps to 8 and content truncates at maxChars", () => {
    const w = setupWorld(); world = w;
    const brain = w.brain;
    for (let i = 0; i < 12; i++) {
      brain.memory.publish({ organizationId: w.org, workspaceId: w.workspaceId, sourceId: `doc-${i}`, text: `rollout note ${i} ${"z".repeat(200)}` });
    }
    const found = brain.memory.search(query({ limit: 50, maxChars: 40 }), { organizationId: w.org, workspaceId: w.workspaceId });
    expect(found.results.length).toBeLessThanOrEqual(8);
    for (const r of found.results) expect(r.content.length).toBeLessThanOrEqual(40);
  });
});
