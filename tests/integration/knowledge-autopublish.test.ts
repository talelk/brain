import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeAsset } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";
import { achievedMission, command, reuseSearch } from "../support/reuse";

let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

const assets = async (w: TestWorld): Promise<KnowledgeAsset[]> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "knowledgeAssets.list", workspaceId: w.workspaceId, limit: 100 })) as unknown as { snapshot: { items: KnowledgeAsset[] } }).snapshot.items;
const summary = async (w: TestWorld) =>
  ((await w.brain.executeQuery(w.owner, { queryType: "library.summary", workspaceId: w.workspaceId })) as unknown as { snapshot: Record<string, number | boolean> }).snapshot;

const REPORT = {
  summary: "Pricing confusion drove most cancellations; two plans overlap and the renewal email hides the price.",
  deliverable: "# Churn causes\n\n1. Pricing confusion (finance export).\n2. Missing onboarding follow-up (support tickets).\n3. A competitor discount in March (sales notes).\n\nEach cause cites its data source in the table below.",
  criteria: [{ criterion: "The report names the three biggest churn causes", met: true, evidence: "Section 1 to 3 name them" }],
  assumptions: ["Churn means cancelled paid plans in the quarter"],
};
const CHURN = { title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report with the three biggest causes", criteria: ["The report names the three biggest churn causes", "Every cause cites its data source"] };

describe("verified write-ups publish themselves on a single-owner install (row 47, ADR 0007)", () => {
  it("publishes as self-reviewed and automatic, searchable, counted on the Library summary; Withdraw undoes it", async () => {
    world = setupWorld();
    const w = world;
    expect((await summary(w))["autoPublishKnowledge"]).toBe(true);
    const id = await achievedMission(w, "auto", { ...CHURN, autoPublish: true, report: REPORT });
    const [asset] = await assets(w);
    expect(asset).toMatchObject({ state: "published", missionId: id, selfReviewed: true, autoPublished: true, reviewedBy: "owner-1" });
    expect(asset!.contentDigest).toMatch(/^sha256:/);
    expect((await reuseSearch(w, "quarterly churn report")).some((hit) => hit.itemRef === `knowledge:${asset!.assetId}` && hit.selfReviewed === true)).toBe(true);
    expect(await summary(w)).toMatchObject({ awaitingReview: 0, publishedKnowledge: 1, learnedThisWeek: 1, learnedAutomatically: 1, autoPublishKnowledge: true });

    await command(w, w.owner, "memory.revoke", "auto-withdraw", { sourceId: asset!.assetId, reason: "Withdrawn from search and reuse" });
    expect((await assets(w))[0]!.state).toBe("revoked");
    expect((await reuseSearch(w, "quarterly churn report")).some((hit) => hit.kind === "knowledge")).toBe(false);
    expect(await summary(w)).toMatchObject({ publishedKnowledge: 0, learnedThisWeek: 0 });
    // Withdrawn stays withdrawn: another pass does not publish it again.
    w.brain.runCapitalization();
    expect((await assets(w))[0]!.state).toBe("revoked");
  });

  it("with the setting off nothing publishes; Approve all verified publishes every waiting write-up; turning the setting back on lets the next ones through", async () => {
    world = setupWorld();
    const w = world;
    await achievedMission(w, "a", { ...CHURN, report: REPORT });
    await achievedMission(w, "b", { title: "Pricing review", intent: "Review the pricing plans and recommend which to keep", report: REPORT });
    expect(await summary(w)).toMatchObject({ awaitingReview: 2, publishedKnowledge: 0, autoPublishKnowledge: false });
    const receipt = await command(w, w.owner, "knowledge.approveVerified", "bulk-1", {});
    expect(receipt.accepted).toBe(true);
    expect((await assets(w)).map((asset) => asset.state)).toEqual(["published", "published"]);
    expect((await assets(w)).every((asset) => asset.selfReviewed === true && !asset.autoPublished)).toBe(true);
    expect(await summary(w)).toMatchObject({ awaitingReview: 0, publishedKnowledge: 2 });
    // A second click changes nothing.
    await command(w, w.owner, "knowledge.approveVerified", "bulk-2", {});
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM memory_assets").get()).toEqual({ n: 2 });
  });

  it("turning the setting on publishes what is already waiting", async () => {
    world = setupWorld();
    const w = world;
    await achievedMission(w, "wait", { ...CHURN, report: REPORT });
    expect((await assets(w))[0]!.state).toBe("extracted");
    await command(w, w.owner, "library.settings.set", "on-again", { autoPublishKnowledge: true });
    expect((await assets(w))[0]).toMatchObject({ state: "published", autoPublished: true });
  });

  it("leaves it for a person once another reviewer exists, or when the write-up has a secret", async () => {
    world = setupWorld();
    const w = world;
    await achievedMission(w, "secret", { title: "Credentials audit", intent: "Audit credentials for the quarter", decision: "Rotate the key api_key = AKIAABCDEFGHIJKLMNOP first", autoPublish: true });
    expect((await assets(w))[0]).toMatchObject({ state: "extracted", rejectionReason: expect.stringMatching(/secret/) });

    w.brain.ensurePrincipal(w.org, "reviewer-2", "human");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?,?,?,'workspace-lead',1,'owner-1',?)").run(w.workspaceId, w.org, "reviewer-2", w.brain.store.now());
    await achievedMission(w, "peer", { ...CHURN, autoPublish: true, report: REPORT });
    const churn = (await assets(w)).find((asset) => asset.title === CHURN.title)!;
    expect(churn.state).toBe("extracted");
    expect(churn.rejectionReason).toBeUndefined();
    expect(await summary(w)).toMatchObject({ awaitingReview: 1 });
  });

  it("never touches effects, approvals or capability candidates", async () => {
    world = setupWorld();
    const w = world;
    await achievedMission(w, "scope", { ...CHURN, autoPublish: true, report: REPORT });
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get()).toEqual({ n: 0 });
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    expect(ws.prepare("SELECT COUNT(*) AS n FROM tool_candidates").get()).toEqual({ n: 0 });
  });
});

describe("write-ups carry the result (row 48)", () => {
  it("includes the Result summary, a bounded deliverable excerpt, each criterion with how it was checked, assumptions and what was reused; omits empty sections", async () => {
    world = setupWorld();
    const w = world;
    const first = await achievedMission(w, "src", { title: "Retention study", intent: "Study retention drivers for the churn work", report: REPORT, autoPublish: true });
    const long = `# Churn causes\n\n${"A long paragraph about churn that keeps going. ".repeat(120)}\n\nTAIL-MARKER-END`;
    const id = await achievedMission(w, "main", { ...CHURN, autoPublish: true, report: { ...REPORT, deliverable: long }, reuse: [`mission:${first}`] });
    const reuser = await achievedMission(w, "reuser", { title: "Churn follow-up", intent: "Plan the follow-up actions after the churn study", report: REPORT, autoPublish: true, outputs: [{ name: "plan.md", text: "Follow-up plan: fix the renewal email wording first." }] });
    const content = (await assets(w)).find((asset) => asset.missionId === id)!.content;
    expect(content).toContain("## Result");
    expect(content).toContain("Pricing confusion drove most cancellations");
    expect(content).toContain("## Deliverable (excerpt)");
    expect(content).toContain("Churn causes");
    expect(content).toContain("(excerpt: the first 2400 of");
    expect(content).not.toContain("TAIL-MARKER-END");
    expect(content).toContain("## Success criteria and how each was checked");
    expect(content).toContain("Worker's report: met, Section 1 to 3 name them");
    expect(content).toContain("The report names the three biggest churn causes [verified: human sign-off");
    expect(content).toContain("## Assumptions made");
    expect(content).toContain("Churn means cancelled paid plans in the quarter (the worker's assumption, not checked)");
    expect(content).toContain("## What was reused\n- mission: Retention study (from mission");
    expect(content).not.toContain("None.");
    expect(content).not.toContain("## Decisions accepted");
    expect(content).not.toContain("## What the verdict rejected");
    expect(content.length).toBeLessThanOrEqual(12000);
    expect(content).toContain("## Goal\nAnalyse customer churn for the quarter");
    const reuserContent = (await assets(w)).find((asset) => asset.missionId === reuser)!.content;
    expect(reuserContent).toContain("## Verified outputs");
    expect(reuserContent).toContain("plan.md");
  });

  it("does not write up a sample or test mission, or one with almost no result", async () => {
    world = setupWorld();
    const w = world;
    await achievedMission(w, "sample", { title: "Sample goal: check this install", intent: "Write a short plain-language note that explains what Brain does", autoPublish: true });
    await achievedMission(w, "tiny", { title: "Say hello", intent: "Say hello to the team and wish them luck", report: { summary: "Done.", deliverable: "Hello team." }, autoPublish: true });
    await achievedMission(w, "noreport", { title: "Quiet mission", intent: "A mission that left no written result at all", report: null, autoPublish: true });
    expect(await assets(w)).toEqual([]);
    expect(await summary(w)).toMatchObject({ awaitingReview: 0, publishedKnowledge: 0 });
  });

  it("a newer write-up of the same goal supersedes the older one in search and in the inbox", async () => {
    world = setupWorld();
    const w = world;
    const older = await achievedMission(w, "old", { ...CHURN, report: REPORT });
    const newer = await achievedMission(w, "new", { ...CHURN, intent: `${CHURN.intent}.`, report: { ...REPORT, summary: `${REPORT.summary} Updated for the new quarter.` } });
    const list = await assets(w);
    const oldAsset = list.find((asset) => asset.missionId === older)!;
    const newAsset = list.find((asset) => asset.missionId === newer)!;
    expect(oldAsset.supersededBy).toBe(newAsset.assetId);
    expect(oldAsset.rejectionReason).toMatch(/newer write-up/);
    expect(newAsset.supersededBy).toBeUndefined();
    expect(await summary(w)).toMatchObject({ awaitingReview: 1 });
    await command(w, w.owner, "knowledge.approveVerified", "sup-bulk", {});
    expect((await assets(w)).find((asset) => asset.missionId === older)!.state).toBe("extracted");
    const hits = (await reuseSearch(w, "quarterly churn report causes")).filter((hit) => hit.kind === "knowledge");
    expect(hits.map((hit) => hit.itemRef)).toEqual([`knowledge:${newAsset.assetId}`]);
  });

  it("supersedes a published older write-up and unindexes it", async () => {
    world = setupWorld();
    const w = world;
    const older = await achievedMission(w, "pold", { ...CHURN, report: REPORT, autoPublish: true });
    const oldAsset = (await assets(w)).find((asset) => asset.missionId === older)!;
    expect(oldAsset.state).toBe("published");
    const newer = await achievedMission(w, "pnew", { ...CHURN, report: REPORT, autoPublish: true });
    const list = await assets(w);
    expect(list.find((asset) => asset.missionId === older)).toMatchObject({ state: "revoked", supersededBy: list.find((asset) => asset.missionId === newer)!.assetId });
    expect((await reuseSearch(w, "quarterly churn report causes")).filter((hit) => hit.kind === "knowledge")).toHaveLength(1);
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM memory_assets WHERE revoked=0").get()).toEqual({ n: 1 });
  });
});

describe("the first sweep after a deploy (rebuilds write-ups of the earlier shape)", () => {
  const OLD_FOOTER = "Claim basis: statements tagged [verified: ...] come from the mission's verified evidence bundle.";
  const asOldShape = (w: TestWorld, missionId: string, createdAt: number) => {
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    db.prepare("UPDATE knowledge_assets SET content=?, created_at_ms=? WHERE mission_id=?").run(`# Old\n\n## Goal\nx\n\n## Verified outputs\nNone.\n\n${OLD_FOOTER}`, createdAt, missionId);
  };

  it("publishes only the newest of two same-goal write-ups, a unique one, and sets a thin one aside", async () => {
    world = setupWorld();
    const w = world;
    const older = await achievedMission(w, "dup-old", { ...CHURN, report: REPORT });
    const newer = await achievedMission(w, "dup-new", { ...CHURN, report: REPORT });
    const unique = await achievedMission(w, "uniq", { title: "Pricing review", intent: "Review the pricing plans and recommend which to keep", report: REPORT });
    const thin = await achievedMission(w, "thin", { title: "Onboarding check", intent: "Check the onboarding checklist for gaps in the first week", report: REPORT });
    // The thin one loses its stored result, so a rebuild finds almost nothing.
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    db.prepare("DELETE FROM step_outputs WHERE run_id=?").run("run-thin");
    asOldShape(w, older, 1_000); asOldShape(w, newer, 2_000); asOldShape(w, unique, 3_000); asOldShape(w, thin, 4_000);
    expect((await assets(w)).every((asset) => asset.state === "extracted")).toBe(true);

    await command(w, w.owner, "library.settings.set", "sweep-on", { autoPublishKnowledge: true });
    const list = await assets(w);
    const of = (missionId: string) => list.find((asset) => asset.missionId === missionId)!;
    expect(of(newer)).toMatchObject({ state: "published", autoPublished: true });
    expect(of(newer).content).toContain("## Result");
    expect(of(unique)).toMatchObject({ state: "published", autoPublished: true });
    expect(of(older)).toMatchObject({ state: "extracted", supersededBy: of(newer).assetId });
    expect(of(older).rejectionReason).toMatch(/newer write-up/);
    expect(of(thin)).toMatchObject({ state: "extracted" });
    expect(of(thin).rejectionReason).toMatch(/Not kept/);
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM memory_assets WHERE revoked=0").get()).toEqual({ n: 2 });
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM memory_assets WHERE source_id=?").get(of(older).assetId)).toEqual({ n: 0 });
    // A second pass changes nothing.
    w.brain.runCapitalization();
    expect((await assets(w)).map((asset) => asset.state).sort()).toEqual(["extracted", "extracted", "published", "published"]);
  });
});

