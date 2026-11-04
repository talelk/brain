import { afterEach, describe, expect, it } from "vitest";
import { validate } from "@brain/contracts/validate";
import type { CapabilityCandidate, CapitalizationRun, KnowledgeAsset } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";
import { activeTool, captureOperation } from "../support/capitalization";

let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

async function run(world: TestWorld, commandType: string, key: string, payload: Record<string, unknown>) {
  return (await world.brain.executeCommand(world.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    workspaceId: world.workspaceId, idempotencyKey: key, payload,
  } as never, key)).receipt;
}

async function view<T>(world: TestWorld, queryType: string): Promise<T[]> {
  const response = (await world.brain.executeQuery(world.owner, { queryType, workspaceId: world.workspaceId, limit: 100 })) as unknown as { snapshot: { items: T[] } };
  return response.snapshot.items;
}

describe("autonomous capitalization (T57, E110)", () => {
  it("captures L0, extracts L1 and deduplicates tested L2 candidates idempotently", async () => {
    world = setupWorld();
    const w = world;
    const evidence = ["root-cap-1", "root-cap-2", "root-cap-3"].map((root) => captureOperation(w, root));
    captureOperation(w, "root-cap-4");
    expect(w.brain.runCapitalization()).toEqual({ processed: 4, failed: 0 });
    expect(w.brain.runCapitalization()).toEqual({ processed: 0, failed: 0 });

    const assets = await view<KnowledgeAsset>(w, "knowledgeAssets.list");
    const candidates = await view<CapabilityCandidate>(w, "capabilityCandidates.list");
    const runs = await view<CapitalizationRun>(w, "capitalizationRuns.list");
    expect(assets).toHaveLength(1);
    expect(assets[0]!.sourceCount).toBe(4);
    expect(assets[0]!.provenance.map((item) => item.evidenceDigest)).toEqual(expect.arrayContaining(evidence));
    expect(assets[0]!.state).toBe("extracted");
    expect(validate("KnowledgeAsset", assets[0]).ok).toBe(true);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.state).toBe("quarantined");
    expect(candidates[0]!.testStatus).toBe("passed");
    expect(candidates[0]!.sourceCount).toBe(4);
    expect(candidates[0]!.evidenceDigests).toHaveLength(4);
    expect(candidates[0]!.existingAlternatives).toEqual([activeTool(w)]);
    expect(validate("CapabilityCandidate", candidates[0]).ok).toBe(true);
    expect(runs).toHaveLength(4);
    expect(runs.every((item) => item.state === "succeeded")).toBe(true);
    expect(runs.every((item) => item.candidateCount === 1)).toBe(true);
    expect((w.brain.store.control.prepare("SELECT COUNT(*) AS count FROM memory_assets").get() as { count: number }).count).toBe(0);
  });

  it("requires independent review, all test evidence and the exact active release for L3", async () => {
    world = setupWorld();
    const w = world;
    for (const root of ["root-review-1", "root-review-2", "root-review-3"]) captureOperation(w, root);
    w.brain.runCapitalization();
    const candidate = (await view<CapabilityCandidate>(w, "capabilityCandidates.list"))[0]!;
    await expect(Promise.resolve().then(async () => await run(w, "tool.publish", "publish-before-review", { release: candidate.release, evidence: candidate.evidenceDigests }))).rejects.toThrow(/independent review/);
    await run(w, "capability.review", "review-cap", { candidateId: candidate.candidateId, decision: "approve", reason: "Provenance, typed shape and test evidence verified" });
    await expect(Promise.resolve().then(async () => await run(w, "tool.publish", "publish-missing-evidence", { release: candidate.release, evidence: candidate.evidenceDigests.slice(1) }))).rejects.toThrow(/all candidate test evidence/);
    await run(w, "tool.publish", "publish-cap", { release: candidate.release, evidence: candidate.evidenceDigests });
    const published = (await view<CapabilityCandidate>(w, "capabilityCandidates.list"))[0]!;
    expect(published.state).toBe("published");
    expect(published.reviewedBy).toBe(w.owner.actorId);
    expect((await view<KnowledgeAsset>(w, "knowledgeAssets.list"))[0]!.state).toBe("extracted");
    expect((w.brain.store.control.prepare("SELECT COUNT(*) AS count FROM memory_assets").get() as { count: number }).count).toBe(0);
  });

  it("keeps rejected candidates quarantined from execution", async () => {
    world = setupWorld();
    const w = world;
    for (const root of ["root-reject-1", "root-reject-2", "root-reject-3"]) captureOperation(w, root);
    w.brain.runCapitalization();
    const candidate = (await view<CapabilityCandidate>(w, "capabilityCandidates.list"))[0]!;
    await run(w, "capability.review", "reject-cap", { candidateId: candidate.candidateId, decision: "reject", reason: "Existing alternative remains preferred" });
    await expect(Promise.resolve().then(async () => await run(w, "tool.publish", "publish-rejected", { release: candidate.release, evidence: candidate.evidenceDigests }))).rejects.toThrow(/independent review/);
    expect((await view<CapabilityCandidate>(w, "capabilityCandidates.list"))[0]!.state).toBe("rejected");
  });
});
