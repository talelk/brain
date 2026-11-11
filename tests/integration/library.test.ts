import { afterEach, describe, expect, it } from "vitest";
import { setupWorld, type TestWorld } from "../helpers";
import { achievedMission, command } from "../support/reuse";

let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

const summary = async (w: TestWorld) =>
  ((await w.brain.executeQuery(w.owner, { queryType: "library.summary", workspaceId: w.workspaceId })) as unknown as { snapshot: Record<string, number> }).snapshot;

describe("Library counts (#73)", () => {
  it("counts what waits for review, what is published, documents, Plays and tools, exactly", async () => {
    world = setupWorld();
    const w = world;
    expect(await summary(w)).toMatchObject({ awaitingReview: 0, publishedKnowledge: 0, documents: 0 });
    await achievedMission(w, "one", { title: "Quarterly churn report", intent: "Analyse churn", criteria: ["named causes"] });
    await achievedMission(w, "two", { title: "Pricing review", intent: "Review pricing", criteria: ["named options"] });
    await command(w, w.owner, "document.upload", "doc-1", { title: "Notes", fileName: "notes.md", mediaType: "text/markdown", bytesBase64: Buffer.from("# Notes\nHello").toString("base64") });
    const before = await summary(w);
    expect(before).toMatchObject({ awaitingReview: 2, publishedKnowledge: 0, documents: 1 });
    expect(typeof before["plays"]).toBe("number");
    expect(typeof before["tools"]).toBe("number");

    const assets = ((await w.brain.executeQuery(w.owner, { queryType: "knowledgeAssets.list", workspaceId: w.workspaceId, limit: 10 })) as unknown as { snapshot: { items: Array<{ assetId: string }> } }).snapshot.items;
    await command(w, w.owner, "knowledge.review", "approve-1", { assetId: assets[0]!.assetId, decision: "approve", reason: "Looks right" });
    expect(await summary(w)).toMatchObject({ awaitingReview: 1, publishedKnowledge: 1, documents: 1 });
  });
});
