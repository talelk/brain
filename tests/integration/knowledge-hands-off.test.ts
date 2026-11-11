import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeAsset } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";
import { achievedMission, command, reuseSearch } from "../support/reuse";

// Track AB (backlog 68, 69, ADR 0007 amendment 2026-11-11): a mission the Governor itself closes after independent verified evidence
// publishes its write-up on a single-owner install, exactly like a mission a person signed off.
let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

const assets = async (w: TestWorld): Promise<KnowledgeAsset[]> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "knowledgeAssets.list", workspaceId: w.workspaceId, limit: 100 })) as unknown as { snapshot: { items: KnowledgeAsset[] } }).snapshot.items;
const summary = async (w: TestWorld) =>
  ((await w.brain.executeQuery(w.owner, { queryType: "library.summary", workspaceId: w.workspaceId })) as unknown as { snapshot: Record<string, unknown> }).snapshot;

const REPORT = {
  summary: "Pricing confusion drove most cancellations; two plans overlap and the renewal email hides the price.",
  deliverable: "# Churn causes\n\n1. Pricing confusion (finance export).\n2. Missing onboarding follow-up (support tickets).\n3. A competitor discount in March (sales notes).\n\nEach cause cites its data source in the table below.",
  criteria: [{ criterion: "The report names the three biggest churn causes", met: true, evidence: "Section 1 to 3 name them" }],
  assumptions: ["Churn means cancelled paid plans in the quarter"],
};
const CHURN = { title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report with the three biggest causes", criteria: ["The report names the three biggest churn causes"] };
const PRICING = { title: "Pricing review", intent: "Review the pricing plans and recommend which to keep", criteria: ["Plans compared"] };

const addReviewer = (w: TestWorld): void => {
  w.brain.ensurePrincipal(w.org, "reviewer-2", "human");
  w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?,?,?,'workspace-lead',1,'owner-1',?)").run(w.workspaceId, w.org, "reviewer-2", w.brain.store.now());
};

describe("a mission the Governor closed publishes its write-up on a single-owner install", () => {
  it("publishes as self-reviewed and automatic with nobody acting; counted apart from what needs a person; Withdraw undoes it", async () => {
    world = setupWorld();
    const w = world;
    const id = await achievedMission(w, "ho", { ...CHURN, report: REPORT, autoPublish: true, handsOff: true });
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    expect(db.prepare("SELECT state, outcome FROM missions WHERE id=?").get(id)).toMatchObject({ state: "closed", outcome: "achieved" });
    const [asset] = await assets(w);
    expect(asset).toMatchObject({ state: "published", missionId: id, selfReviewed: true, autoPublished: true, reviewedBy: "owner-1" });
    expect((await reuseSearch(w, "quarterly churn report")).some((hit) => hit.itemRef === `knowledge:${asset!.assetId}` && hit.selfReviewed === true)).toBe(true);
    expect(await summary(w)).toMatchObject({ awaitingReview: 0, needsPerson: { writeups: 0, tools: 0, plays: 0 }, publishedAutomatically: 1, publishedKnowledge: 1, learnedThisWeek: 1, learnedAutomatically: 1 });

    await command(w, w.owner, "memory.revoke", "ho-withdraw", { sourceId: asset!.assetId, reason: "Withdrawn from search and reuse" });
    w.brain.runCapitalization();
    expect((await assets(w))[0]!.state).toBe("revoked");
    expect((await reuseSearch(w, "quarterly churn report")).some((hit) => hit.kind === "knowledge")).toBe(false);
  });

  it("falls back to the sole reviewer when the write-up's producer is no longer an active reviewer", async () => {
    world = setupWorld();
    const w = world;
    await achievedMission(w, "ghost", { ...PRICING, report: REPORT, autoPublish: true, handsOff: true });
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    db.prepare("UPDATE knowledge_assets SET state='extracted', reviewed_by=NULL, auto_published=0, self_reviewed=0, producer_id='departed-1', content_digest=NULL").run();
    w.brain.runCapitalization();
    expect((await assets(w))[0]).toMatchObject({ state: "published", autoPublished: true, selfReviewed: true, reviewedBy: "owner-1" });
  });

  it("stays in the inbox, counted as needing a person, once another reviewer exists", async () => {
    world = setupWorld();
    const w = world;
    addReviewer(w);
    await achievedMission(w, "peer", { ...CHURN, report: REPORT, autoPublish: true, handsOff: true });
    const [asset] = await assets(w);
    expect(asset).toMatchObject({ state: "extracted" });
    expect(asset!.rejectionReason).toBeUndefined();
    expect(await summary(w)).toMatchObject({ awaitingReview: 1, needsPerson: { writeups: 1 }, publishedAutomatically: 0 });
  });

  it("sets a write-up with a secret aside for a person and counts it as needing one", async () => {
    world = setupWorld();
    const w = world;
    await achievedMission(w, "secret", { title: "Credentials audit", intent: "Audit credentials for the quarter", decision: "Rotate the key api_key = AKIAABCDEFGHIJKLMNOP first", autoPublish: true, handsOff: true });
    const [asset] = await assets(w);
    expect(asset).toMatchObject({ state: "extracted", rejectionReason: expect.stringMatching(/^Left for a person: .*secret/) });
    expect(await summary(w)).toMatchObject({ awaitingReview: 1, needsPerson: { writeups: 1 }, publishedAutomatically: 0, publishedKnowledge: 0 });
  });

  it("does not write up a sample mission or one with almost no result, and touches no approval or capability candidate", async () => {
    world = setupWorld();
    const w = world;
    await achievedMission(w, "sample", { title: "Sample goal: check this install", intent: "Write a short plain-language note that explains what Brain does", handsOff: true });
    await achievedMission(w, "tiny", { title: "Say hello", intent: "Say hello to the team and wish them luck", report: { summary: "Done.", deliverable: "Hello team." }, handsOff: true });
    expect(await assets(w)).toEqual([]);
    expect(await summary(w)).toMatchObject({ awaitingReview: 0, publishedAutomatically: 0 });
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get()).toEqual({ n: 0 });
    expect(w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT COUNT(*) AS n FROM tool_candidates").get()).toEqual({ n: 0 });
  });

  it("the first pass after a deploy publishes the verified write-ups that were already waiting", async () => {
    world = setupWorld();
    const w = world;
    await achievedMission(w, "w1", { ...CHURN, report: REPORT, autoPublish: true, handsOff: true });
    await achievedMission(w, "w2", { ...PRICING, report: REPORT, autoPublish: true, handsOff: true });
    await achievedMission(w, "w3", { title: "Onboarding check", intent: "Check the onboarding checklist for gaps in the first week", report: REPORT, autoPublish: true, handsOff: true });
    // As on the live demo before this change: written up, never published, awaiting review.
    w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("UPDATE knowledge_assets SET state='extracted', reviewed_by=NULL, auto_published=0, self_reviewed=0, content_digest=NULL").run();
    w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("DELETE FROM library_settings").run();
    expect(await summary(w)).toMatchObject({ awaitingReview: 3, publishedAutomatically: 0 });
    w.brain.runCapitalization();
    expect((await assets(w)).map((asset) => asset.state)).toEqual(["published", "published", "published"]);
    expect(await summary(w)).toMatchObject({ awaitingReview: 0, publishedAutomatically: 3 });
    w.brain.runCapitalization();
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM memory_assets WHERE revoked=0").get()).toEqual({ n: 3 });
  });
  it("sets aside older notes that have no mission and no title instead of counting them for review for ever", async () => {
    world = setupWorld();
    const w = world;
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    db.prepare("INSERT INTO knowledge_assets(id,signature,operation_id,state,classification,content,source_count,created_at_ms,updated_at_ms) VALUES ('old-note','sha256:old','mission-knowledge','extracted','internal','{\"raw\":true}',1,1,1)").run();
    expect(await summary(w)).toMatchObject({ awaitingReview: 1 });
    w.brain.runCapitalization();
    expect(await summary(w)).toMatchObject({ awaitingReview: 0 });
    expect(db.prepare("SELECT rejection_reason AS r FROM knowledge_assets WHERE id='old-note'").get()).toEqual({ r: "Not kept: an older note with no mission or title, nothing readable to review" });
  });
});
