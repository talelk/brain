import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeAsset } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";
import { achievedMission, command, reuseSearch } from "../support/reuse";

/**
 * Stale knowledge is marked (#133): a write-up records fingerprints of the documents and outputs it rests on; when one changes,
 * the published asset is marked stale (readable, labelled, never deleted) until a person re-confirms or revokes it.
 */
let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

const assets = async (w: TestWorld): Promise<KnowledgeAsset[]> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "knowledgeAssets.list", workspaceId: w.workspaceId, limit: 100 })) as unknown as { snapshot: { items: KnowledgeAsset[] } }).snapshot.items;
const learned = async (w: TestWorld, missionId: string): Promise<KnowledgeAsset> => (await assets(w)).find((asset) => asset.missionId === missionId)!;
const upload = async (w: TestWorld, key: string, text: string, title: string): Promise<string> =>
  (await command(w, w.owner, "document.upload", key, { title, fileName: "note.md", mediaType: "text/markdown", bytesBase64: Buffer.from(text).toString("base64") })).resourceId!;
const revise = async (w: TestWorld, id: string, key: string, text: string, title: string): Promise<void> => {
  const current = ((await w.brain.executeQuery(w.owner, { queryType: "documents.get", workspaceId: w.workspaceId, resourceId: id })) as unknown as { snapshot: { version: number } }).snapshot;
  await command(w, w.owner, "document.revise", key, { documentId: id, title, fileName: "note.md", mediaType: "text/markdown", bytesBase64: Buffer.from(text).toString("base64") }, current.version);
};
const review = (w: TestWorld, key: string, assetId: string, decision: string, reason: string) => command(w, w.owner, "knowledge.review", key, { assetId, decision, reason });

const REPORT = {
  summary: "Pricing confusion drove most cancellations; two plans overlap and the renewal email hides the price.",
  deliverable: "# Churn causes\n\n1. Pricing confusion (finance export).\n2. Missing onboarding follow-up (support tickets).\n3. A competitor discount in March (sales notes).\n\nEach cause cites its data source in the table below.",
  criteria: [{ criterion: "The report names the three biggest churn causes", met: true, evidence: "Section 1 to 3 name them" }],
  assumptions: ["Churn means cancelled paid plans in the quarter"],
};
const CHURN = { title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report with the three biggest causes", criteria: ["The report names the three biggest churn causes", "Every cause cites its data source"] };
const SOURCE = "Finance export: churn by plan for the quarter. Plan A lost 40 accounts, plan B lost 12, and the renewal email hid the price in both cases.";

async function published(w: TestWorld): Promise<{ missionId: string; documentId: string; otherId: string; assetId: string }> {
  const documentId = await upload(w, "src", SOURCE, "Churn export");
  const otherId = await upload(w, "other", "Office plant watering rota for the spring, unrelated to any customer work.", "Plant rota");
  const missionId = await achievedMission(w, "a", { ...CHURN, autoPublish: true, report: REPORT, documents: [documentId] });
  const asset = await learned(w, missionId);
  expect(asset).toMatchObject({ state: "published" });
  expect(asset.stale).toBeUndefined();
  return { missionId, documentId, otherId, assetId: asset.assetId };
}

describe("a source change marks the knowledge built on it stale (#133)", () => {
  it("marks the dependent asset stale, still readable, flagged in search and reuse, and leaves unrelated changes alone", async () => {
    world = setupWorld();
    const w = world;
    const { missionId, documentId, otherId, assetId } = await published(w);

    await revise(w, otherId, "rev-other", "Office plant watering rota, now on Tuesdays.", "Plant rota");
    expect((await learned(w, missionId)).stale).toBeUndefined();

    await revise(w, documentId, "rev-src", `${SOURCE} A third plan was added in May.`, "Churn export");
    const asset = await learned(w, missionId);
    expect(asset).toMatchObject({ state: "published", stale: { changes: [{ kind: "document", id: documentId, title: "Churn export", what: "revised" }] } });
    expect(asset.content).toContain("Churn causes");

    const hits = w.brain.knowledgeHits(w.owner, w.workspaceId, "churn causes pricing", 5).filter((hit) => hit.sourceId === assetId);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.status).toBe("stale");

    // The Knowledge page's own search (memory.search) labels it too, with what changed.
    const searched = ((await w.brain.executeQuery(w.owner, { queryType: "memory.search", workspaceId: w.workspaceId, memoryQuery: { contractVersion: "brain.memory/v1", queryId: "q-1", scope: { organizationId: w.org, visibility: "workspace", workspaceId: w.workspaceId }, query: "churn causes pricing", sourceTypes: ["knowledge"], limit: 5, maxChars: 1500 } } as never)) as unknown as { snapshot: { results: Array<{ sourceId: string; status: string; stale?: { changes: unknown[] } }> } }).snapshot.results;
    expect(searched.find((hit) => hit.sourceId === assetId)).toMatchObject({ status: "stale", stale: { changes: [{ what: "revised" }] } });

    const reused = (await reuseSearch(w, "quarterly churn report")).find((item) => item.itemRef === `knowledge:${assetId}`);
    expect(reused?.stale?.changes[0]).toMatchObject({ kind: "document", what: "revised" });
  });

  it("keeps the mark when the document returns to its old text, and a removed document marks it too", async () => {
    world = setupWorld();
    const w = world;
    const { missionId, documentId } = await published(w);
    await revise(w, documentId, "rev-1", `${SOURCE} Changed.`, "Churn export");
    expect((await learned(w, missionId)).stale).toBeDefined();
    await revise(w, documentId, "rev-2", SOURCE, "Churn export");
    w.brain.runCapitalization();
    expect((await learned(w, missionId)).stale?.changes[0]?.what).toBe("revised");
  });

  it("marks knowledge stale when a document it rests on is removed", async () => {
    world = setupWorld();
    const w = world;
    const { missionId, documentId } = await published(w);
    const current = ((await w.brain.executeQuery(w.owner, { queryType: "documents.get", workspaceId: w.workspaceId, resourceId: documentId })) as unknown as { snapshot: { version: number } }).snapshot;
    await command(w, w.owner, "document.delete", "del-src", { documentId, reason: "Obsolete" }, current.version);
    expect((await learned(w, missionId)).stale?.changes[0]).toMatchObject({ kind: "document", what: "removed" });
  });

  it("marks knowledge stale when a later mission continues one of its outputs with a verified version", async () => {
    world = setupWorld();
    const w = world;
    const missionId = await achievedMission(w, "o", { ...CHURN, autoPublish: true, report: REPORT, outputs: [{ name: "churn.md", text: "# Churn\n\nPlan A lost 40 accounts." }] });
    expect((await learned(w, missionId)).stale).toBeUndefined();
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const first = ws.prepare("SELECT id FROM mission_outputs WHERE mission_id=?").get(missionId) as { id: string };
    const follow = await achievedMission(w, "p", { title: "Churn follow up", intent: "Follow up the plan A churn with a new export", report: REPORT });
    ws.prepare("INSERT INTO mission_outputs(id,mission_id,name,continues_output_id,created_at_ms) VALUES ('out-next',?,?,?,?)").run(follow, "churn.md", first.id, Date.now());
    ws.prepare("INSERT INTO output_versions(id,output_id,work_item_id,artifact_digest,state,verified,created_at_ms) VALUES ('ver-next','out-next','w',?, 'final', 1, ?)").run(`sha256:${"5".repeat(64)}`, Date.now());
    expect((await learned(w, missionId)).stale?.changes[0]).toMatchObject({ kind: "output", what: "superseded" });
  });
});

describe("a person re-confirms or revokes stale knowledge (#133)", () => {
  it("re-confirm re-fingerprints and clears the mark; a later change marks it again", async () => {
    world = setupWorld();
    const w = world;
    const { missionId, documentId, assetId } = await published(w);
    await expect(review(w, "early", assetId, "reconfirm", "Still holds")).rejects.toThrow("only published knowledge marked stale");

    await revise(w, documentId, "rev-1", `${SOURCE} A third plan was added in May.`, "Churn export");
    expect((await learned(w, missionId)).stale).toBeDefined();
    expect((await review(w, "ok", assetId, "reconfirm", "Checked the new export; the causes hold")).accepted).toBe(true);
    const confirmed = await learned(w, missionId);
    expect(confirmed.stale).toBeUndefined();
    expect(confirmed.reconfirmedAt).toBeDefined();
    expect(confirmed.state).toBe("published");
    expect(w.brain.knowledgeHits(w.owner, w.workspaceId, "churn causes pricing", 5).find((hit) => hit.sourceId === assetId)?.status).toBe("reviewed");

    await revise(w, documentId, "rev-2", `${SOURCE} A fourth plan was added in June.`, "Churn export");
    expect((await learned(w, missionId)).stale?.changes[0]?.what).toBe("revised");
  });

  it("revoke withdraws stale knowledge from search and reuse without deleting it", async () => {
    world = setupWorld();
    const w = world;
    const { missionId, documentId, assetId } = await published(w);
    await revise(w, documentId, "rev-1", `${SOURCE} Changed.`, "Churn export");
    expect((await review(w, "revoke", assetId, "revoke", "The export changed the causes")).accepted).toBe(true);
    expect(await learned(w, missionId)).toMatchObject({ state: "revoked", rejectionReason: expect.stringContaining("Revoked as stale") });
    expect(w.brain.knowledgeHits(w.owner, w.workspaceId, "churn causes pricing", 5).some((hit) => hit.sourceId === assetId)).toBe(false);
    expect((await reuseSearch(w, "quarterly churn report")).some((item) => item.itemRef === `knowledge:${assetId}`)).toBe(false);
  });
});

describe("context packs flag stale knowledge and list what changed since the last pack (#133)", () => {
  it("names stale knowledge in the pack and lists the change once, then not again", async () => {
    world = setupWorld();
    const w = world;
    const { documentId, assetId } = await published(w);
    const bId = await achievedMission(w, "b", { title: "Churn deep dive", intent: "Dig into plan A churn using the earlier quarterly work", report: REPORT, reuse: [`knowledge:${assetId}`] });
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const item = ws.prepare("SELECT work_item_id AS id FROM execution_links WHERE mission_id=?").get(bId) as { id: string };
    const build = (runId: string): string => {
      ws.prepare("INSERT INTO workflow_runs(id,execution_key,config_digest,workflow_digest,adapter_digest,engine_run_id,state,input_digest,created_at_ms) VALUES (?,?,?,?,?,?,'running',?,?)")
        .run(runId, `exec-${runId}`, `sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`, `engine-${runId}`, `sha256:${"4".repeat(64)}`, Date.now());
      ws.prepare("INSERT INTO execution_links(mission_id,work_item_id,run_id,created_at_ms) VALUES (?,?,?,?)").run(bId, item.id, runId, Date.now());
      return w.brain.sessions.contextPackForRun(w.org, w.workspaceId, { runId, jobId: `job-${runId}`, agentId: "task-worker", budgetTokens: 8000 })!.text;
    };

    const fresh = build("run-1");
    expect(fresh).toContain(`knowledge:${assetId}`);
    expect(fresh).not.toContain("STALE");
    expect(fresh).not.toContain("changed since your last context");

    await revise(w, documentId, "rev-1", `${SOURCE} A third plan was added in May.`, "Churn export");
    const changed = build("run-2");
    expect(changed).toContain("Knowledge that changed since your last context");
    expect(changed).toContain('went stale: document "Churn export" was revised');
    expect(changed).toContain("is STALE");

    const later = build("run-3");
    expect(later).toContain("is STALE");
    expect(later).not.toContain("went stale");

    await review(w, "reconfirm", assetId, "reconfirm", "Still holds");
    const confirmed = build("run-4");
    expect(confirmed).toContain("was re-confirmed by a person");
    expect(confirmed).not.toContain("is STALE");
  });
});
