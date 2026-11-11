import { afterEach, describe, expect, it } from "vitest";
import type { AttentionItem, KnowledgeAsset } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";
import { achievedMission, command, reuseSearch } from "../support/reuse";

let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

const assets = async (w: TestWorld): Promise<KnowledgeAsset[]> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "knowledgeAssets.list", workspaceId: w.workspaceId, limit: 100 })) as unknown as { snapshot: { items: KnowledgeAsset[] } }).snapshot.items;
const attention = async (w: TestWorld): Promise<AttentionItem[]> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "attention.list" } as never)) as unknown as { snapshot: { items: AttentionItem[] } }).snapshot.items;
const upload = async (w: TestWorld, key: string, text: string, title: string): Promise<string> =>
  (await command(w, w.owner, "document.upload", key, { title, fileName: "note.md", mediaType: "text/markdown", bytesBase64: Buffer.from(text).toString("base64") })).resourceId!;

const TEXT = "The onboarding checklist has five steps: create the account, invite the team, connect the data source, run the first report and review the access rules with the owner.";

describe("saved documents are reviewable (row 55)", () => {
  it("a saved document waits in the Review inbox as a saved document; Approve publishes it as reviewed knowledge that search and reuse find", async () => {
    world = setupWorld();
    const w = world;
    await command(w, w.owner, "library.settings.set", "off", { autoPublishKnowledge: false });
    const id = await upload(w, "up-1", TEXT, "Onboarding checklist");
    expect(w.brain.runCapitalization()).toBeDefined();
    const [asset] = await assets(w);
    expect(asset).toMatchObject({ operationId: "saved-document", state: "extracted", title: "Onboarding checklist", producedBy: "owner-1" });
    expect(asset!.provenance[0]).toMatchObject({ rootRunId: id });
    // Nothing duplicates on the next pass.
    w.brain.runCapitalization();
    expect(await assets(w)).toHaveLength(1);
    expect((await reuseSearch(w, "onboarding checklist")).some((hit) => hit.kind === "knowledge")).toBe(false);

    expect((await command(w, w.owner, "knowledge.review", "ok-1", { assetId: asset!.assetId, decision: "approve", reason: "Reviewed" })).accepted).toBe(true);
    const [published] = await assets(w);
    expect(published).toMatchObject({ state: "published", selfReviewed: true });
    const after = await reuseSearch(w, "onboarding checklist");
    expect(after.some((hit) => hit.itemRef === `knowledge:${asset!.assetId}`)).toBe(true);
  });

  it("Not now keeps it out of search and the inbox does not propose the same version again", async () => {
    world = setupWorld();
    const w = world;
    await command(w, w.owner, "library.settings.set", "off", { autoPublishKnowledge: false });
    await upload(w, "up-2", TEXT, "Onboarding checklist");
    w.brain.runCapitalization();
    const [asset] = await assets(w);
    await command(w, w.owner, "knowledge.review", "no-1", { assetId: asset!.assetId, decision: "reject", reason: "Not now" });
    w.brain.runCapitalization();
    expect(await assets(w)).toHaveLength(1);
    expect((await assets(w))[0]).toMatchObject({ state: "extracted", rejectionReason: "Not now" });
  });

  it("a person's own upload on a one-person install publishes itself, marked automatic; a secret stays for a person", async () => {
    world = setupWorld();
    const w = world;
    await upload(w, "up-3", TEXT, "Onboarding checklist");
    await upload(w, "up-4", "Deploy notes: api_key = AKIAABCDEFGHIJKLMNOP is used by the job", "Deploy notes");
    w.brain.runCapitalization();
    const list = await assets(w);
    expect(list.find((asset) => asset.title === "Onboarding checklist")).toMatchObject({ state: "published", selfReviewed: true, autoPublished: true });
    expect(list.find((asset) => asset.title === "Deploy notes")).toMatchObject({ state: "extracted", rejectionReason: expect.stringMatching(/secret/) });
  });

  it("a new version replaces the old proposal and a removed document leaves the inbox and search", async () => {
    world = setupWorld();
    const w = world;
    await command(w, w.owner, "library.settings.set", "off", { autoPublishKnowledge: false });
    const id = await upload(w, "up-5", TEXT, "Onboarding checklist");
    w.brain.runCapitalization();
    const first = (await assets(w))[0]!;
    await command(w, w.owner, "knowledge.review", "ok-5", { assetId: first.assetId, decision: "approve", reason: "Reviewed" });
    const document = ((await w.brain.executeQuery(w.owner, { queryType: "documents.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: { version: number } }).snapshot;
    await command(w, w.owner, "document.revise", "rev-5", { documentId: id, title: "Onboarding checklist", fileName: "note.md", mediaType: "text/markdown", bytesBase64: Buffer.from(`${TEXT} A sixth step: schedule the first review.`).toString("base64") }, document.version);
    w.brain.runCapitalization();
    const list = await assets(w);
    expect(list).toHaveLength(2);
    expect(list.find((asset) => asset.assetId === first.assetId)).toMatchObject({ state: "revoked", rejectionReason: expect.stringMatching(/newer version/) });
    const fresh = list.find((asset) => asset.assetId !== first.assetId)!;
    expect(fresh.state).toBe("extracted");
    const revised = ((await w.brain.executeQuery(w.owner, { queryType: "documents.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: { version: number } }).snapshot;
    await command(w, w.owner, "document.delete", "del-5", { documentId: id, reason: "Obsolete" }, revised.version);
    w.brain.runCapitalization();
    expect((await assets(w)).find((asset) => asset.assetId === fresh.assetId)).toMatchObject({ rejectionReason: "The document was removed" });
  });

  it("the result-ready announcement links to the published write-up in the Review inbox", async () => {
    world = setupWorld();
    const w = world;
    const id = await achievedMission(w, "rr", {
      title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report with the three biggest causes", autoPublish: true,
      report: { summary: "Pricing confusion drove most cancellations; two plans overlap.", deliverable: "# Churn causes\n\n1. Pricing confusion.\n2. Missing onboarding follow-up.\n3. A competitor discount in March.\n\nEach cause cites its data source.", criteria: [{ criterion: "delivered", met: true, evidence: "all three named" }] },
    });
    const [asset] = await assets(w);
    expect(asset).toMatchObject({ state: "published", missionId: id });
    const item = (await attention(w)).find((entry) => entry.id === `result:${id}`);
    expect(item).toMatchObject({ kind: "result-ready", knowledgeAssetId: asset!.assetId, detail: "Its write-up is saved to the Library." });
  });
});
