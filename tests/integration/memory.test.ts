import { afterEach, describe, expect, it } from "vitest";
import { sha256Digest, type MemoryQuery } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";

// T39 packet acceptance: reviewed publication through the real command
// surface — digest-pinned CAS content, existing evidence, a distinct
// reviewer, and a redaction profile declared in the active release.
let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

function upload(w: TestWorld, text: string): { artifactId: string; digest: string; bytes: number } {
  const bytes = Buffer.from(text, "utf8");
  const digest = sha256Digest(bytes);
  const up = w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: digest, expectedBytes: bytes.length }) as unknown as { uploadId: string };
  const done = w.brain.putUpload(w.owner, up.uploadId, bytes) as unknown as { artifactId: string; digest: string; bytes: number };
  return { artifactId: done.artifactId, digest: done.digest, bytes: done.bytes };
}

function publishCommand(w: TestWorld, over: Record<string, unknown> = {}) {
  const content = upload(w, "golden workflow rollout checklist");
  const evidence = upload(w, "evidence: rollout dry-run passed");
  const rel = w.brain.activeRelease(w.org)!;
  const docs = ((JSON.parse(rel.manifest) as { manifest: { documents: Array<{ id: string; digest: string }> } }).manifest.documents);
  const profile = docs[0]!;
  return {
    contractVersion: "brain.command/v1", commandId: "cmd-mem", commandType: "memory.publish",
    workspaceId: w.workspaceId, idempotencyKey: "mem-1",
    payload: {
      candidateId: "golden-doc", sourceWorkspaceId: w.workspaceId,
      targetScope: { organizationId: w.org, visibility: "workspace", workspaceId: w.workspaceId },
      content: { ...content, mediaType: "text/plain", classification: "internal" },
      evidenceDigests: [evidence.digest],
      reviewerId: "reviewer-1",
      redactionProfile: { id: profile.id, digest: profile.digest },
      ...over,
    },
  };
}

function mq(w: TestWorld): MemoryQuery {
  return {
    contractVersion: "brain.memory/v1", queryId: "q-mem",
    scope: { organizationId: w.org, visibility: "workspace", workspaceId: w.workspaceId },
    query: "golden", sourceTypes: ["wiki"], limit: 5, maxChars: 2000,
  } as MemoryQuery;
}

function withReviewer(w: TestWorld): void {
  w.brain.ensurePrincipal(w.org, "reviewer-1", "human");
}

describe("reviewed memory publication (T39)", () => {
  it("publishes reviewed CAS content and retrieves it with provenance; degraded honesty preserved", async () => {
    world = setupWorld();
    const w = world;
    withReviewer(w);
    const prev = process.env["BRAIN_TENCENTDB_URL"];
    delete process.env["BRAIN_TENCENTDB_URL"];
    try {
      const { receipt } = w.brain.executeCommand(w.owner, publishCommand(w), "mem-1");
      expect((receipt as { resourceId?: string }).resourceId).toBeTruthy();
      const found = (await w.brain.searchMemoryAsync(w.owner, w.workspaceId, mq(w))) as unknown as {
        snapshot: { results: Array<{ sourceId: string; provenance: string[]; status: string; content: string }>; degraded: boolean; reason?: string };
      };
      expect(found.snapshot.results.map((r) => r.sourceId)).toContain("golden-doc");
      expect(found.snapshot.results[0]?.content).toContain("golden workflow rollout checklist");
      expect(found.snapshot.results[0]?.provenance).toEqual(["golden-doc"]);
      expect(found.snapshot.degraded).toBe(true);
      expect(found.snapshot.reason).toMatch(/TencentDB not configured/);
    } finally {
      if (prev !== undefined) process.env["BRAIN_TENCENTDB_URL"] = prev;
    }
  });

  it("fails remote searches without silently substituting local memory", async () => {
    world = setupWorld();
    const w = world;
    const previous = process.env["BRAIN_TENCENTDB_URL"];
    process.env["BRAIN_TENCENTDB_URL"] = "http://127.0.0.1:1";
    try {
      await expect(w.brain.searchMemoryAsync(w.owner, w.workspaceId, mq(w))).rejects.toThrow(/does not fall back to local memory/);
    } finally {
      if (previous === undefined) delete process.env["BRAIN_TENCENTDB_URL"];
      else process.env["BRAIN_TENCENTDB_URL"] = previous;
    }
  });

  it("rejects self-review, unknown reviewer, missing evidence and undeclared redaction profiles", () => {
    world = setupWorld();
    const w = world;
    withReviewer(w);
    const selfReview = publishCommand(w, { reviewerId: "owner-1" });
    expect(() => w.brain.executeCommand(w.owner, { ...selfReview, commandId: "cmd-mem-a", idempotencyKey: "mem-a" }, "mem-a")).toThrow(/reviewer must differ/);
    const ghost = publishCommand(w, { reviewerId: "ghost" });
    expect(() => w.brain.executeCommand(w.owner, { ...ghost, commandId: "cmd-mem-b", idempotencyKey: "mem-b" }, "mem-b")).toThrow(/not a principal/);
    const noEvidence = publishCommand(w, { evidenceDigests: [`sha256:${"7".repeat(64)}`] });
    expect(() => w.brain.executeCommand(w.owner, { ...noEvidence, commandId: "cmd-mem-c", idempotencyKey: "mem-c" }, "mem-c")).toThrow(/evidence artifact/);
    const badProfile = publishCommand(w, { redactionProfile: { id: "invented", digest: `sha256:${"6".repeat(64)}` } });
    expect(() => w.brain.executeCommand(w.owner, { ...badProfile, commandId: "cmd-mem-d", idempotencyKey: "mem-d" }, "mem-d")).toThrow(/not declared in the active release/);
  });

  it("revoke removes retrieval; export stays honestly partial; outsiders cannot search", async () => {
    world = setupWorld();
    const w = world;
    withReviewer(w);
    w.brain.executeCommand(w.owner, publishCommand(w), "mem-1");
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-mem-rev", commandType: "memory.revoke",
      workspaceId: w.workspaceId, idempotencyKey: "mem-rev",
      payload: { sourceId: "golden-doc", reason: "superseded checklist" },
    }, "mem-rev");
    expect(w.brain.memory.search(mq(w), { organizationId: w.org, workspaceId: w.workspaceId }).results).toEqual([]);
    const exported = w.brain.memory.exportScope(w.org, w.workspaceId);
    expect(exported.completeness).toBe("partial");
    expect(exported.missing).toEqual(["tencentdb-wiki", "tencentdb-codegraph"]);
    await expect(w.brain.searchMemoryAsync(w.actor("mallory", w.workspaceId), w.workspaceId, mq(w))).rejects.toThrow();
  });
});
