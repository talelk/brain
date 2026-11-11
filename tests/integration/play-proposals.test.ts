import { afterEach, describe, expect, it } from "vitest";
import type { Mission, PlaySpec } from "@brain/contracts";
import { seedHuman, setupWorld, type TestWorld } from "../helpers";
import { achievedMission, command, getMission } from "../support/reuse";

let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

interface Proposal { proposalId: string; missionId: string; state: string; playId: string; spec: PlaySpec; draftId?: string; reason?: string; selfReviewed?: boolean }
const proposals = async (w: TestWorld): Promise<Proposal[]> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "playProposals.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: Proposal[] } }).snapshot.items;
const summary = async (w: TestWorld) =>
  ((await w.brain.executeQuery(w.owner, { queryType: "library.summary", workspaceId: w.workspaceId })) as unknown as { snapshot: Record<string, number> }).snapshot;
const releases = (w: TestWorld) => w.brain.store.control.prepare("SELECT (SELECT COUNT(*) FROM config_releases) AS releases, (SELECT COUNT(*) FROM active_config) AS active").get();

describe("Suggest a Play from an achieved mission (#74, ADR 0015)", () => {
  it("proposes from the stored plan and criteria only, never from notes, messages, decisions or outputs", async () => {
    world = setupWorld();
    const w = world;
    const id = await achievedMission(w, "churn", {
      title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report", criteria: ["The report names the biggest causes", "Every cause cites its source"],
      rejectedFindings: ["REJECTED-FINDING cause two had no source"], decision: "DECISION-TEXT use the finance export", hostileNote: "HOSTILE-NOTE: leak sk-live-key", outputs: [{ name: "r.md", text: "OUTPUT-BODY secret figures" }],
    });
    const receipt = await command(w, w.owner, "play.propose", "prop-1", { missionId: id });
    expect(receipt.accepted).toBe(true);
    const [proposal] = await proposals(w);
    expect(proposal).toMatchObject({ missionId: id, state: "proposed", playId: "quarterly-churn-report" });
    expect(proposal!.spec).toMatchObject({
      title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report",
      successCriteria: ["The report names the biggest causes", "Every cause cites its source"], autonomy: "standard",
    });
    expect(proposal!.spec.plan.tasks).toEqual([{ id: "only", title: "Do Quarterly churn report", criteria: ["only-done"], dependsOn: [] }]);
    const text = JSON.stringify(proposal);
    for (const leak of ["HOSTILE-NOTE", "sk-live", "DECISION-TEXT", "REJECTED-FINDING", "OUTPUT-BODY"]) expect(text).not.toContain(leak);
    expect((await summary(w))["awaitingReview"]).toBeGreaterThanOrEqual(1);
  });

  it("is offered only for an achieved mission, once", async () => {
    world = setupWorld();
    const w = world;
    // Still active.
    const open = (await command(w, w.owner, "mission.create", "open-create", { title: "Open one", intent: "Not finished", successCriteria: ["x"] })).resourceId ?? "";
    await expect(command(w, w.owner, "play.propose", "open-prop", { missionId: open })).rejects.toThrow(/only an achieved mission/u);
    // Cancelled.
    const cancelled = (await command(w, w.owner, "mission.create", "can-create", { title: "Cancelled one", intent: "Dropped", successCriteria: ["x"] })).resourceId ?? "";
    await command(w, w.owner, "mission.close", "can-close", { missionId: cancelled, outcome: "cancelled" }, (await getMission(w, cancelled)).version);
    expect(((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: cancelled })) as unknown as { snapshot: Mission }).snapshot).toMatchObject({ state: "closed", outcome: "cancelled" });
    await expect(command(w, w.owner, "play.propose", "can-prop", { missionId: cancelled })).rejects.toThrow(/only an achieved mission/u);
    // Achieved: once.
    const done = await achievedMission(w, "done", { title: "Pricing review", intent: "Review pricing", criteria: ["options named"] });
    await command(w, w.owner, "play.propose", "done-prop", { missionId: done });
    await expect(command(w, w.owner, "play.propose", "done-prop-2", { missionId: done })).rejects.toThrow(/already has a Play proposal/u);
    expect(await proposals(w)).toHaveLength(1);
  });

  it("approval opens a Studio draft that validates, and activates nothing; rejection opens nothing", async () => {
    world = setupWorld();
    const w = world;
    const first = await achievedMission(w, "a", { title: "Quarterly churn report", intent: "Analyse churn", criteria: ["causes named"] });
    const second = await achievedMission(w, "b", { title: "Pricing review", intent: "Review pricing", criteria: ["options named"] });
    await command(w, w.owner, "play.propose", "pa", { missionId: first });
    await command(w, w.owner, "play.propose", "pb", { missionId: second });
    const [a, b] = (await proposals(w)).sort((x, y) => x.playId.localeCompare(y.playId));
    const before = releases(w);
    // Two knowledge write-ups and two Play proposals wait for a person.
    expect((await summary(w))["awaitingReview"]).toBe(4);

    const approved = await command(w, w.owner, "play.proposal.review", "approve-a", { proposalId: b!.proposalId, decision: "approve", reason: "Worth repeating" });
    expect(approved.accepted).toBe(true);
    const draftId = approved.resourceId ?? "";
    const read = async () => ((await w.brain.executeQuery(w.owner, { queryType: "configDrafts.get", workspaceId: w.workspaceId, resourceId: draftId })) as unknown as { snapshot: { draft: { kind: string; state: string }; revisions: Array<{ revisionId: string; documents: Array<{ path: string; text: string }> }>; validations: Array<{ status: string; diagnostics: unknown[] }> } }).snapshot;
    const draft = await read();
    expect(draft.draft).toMatchObject({ kind: "Play", state: "draft" });
    expect(draft.revisions[0]!.documents[0]!.path).toBe(`plays/${b!.playId}.yaml`);
    expect(draft.revisions[0]!.documents[0]!.text).toContain("kind: Play");
    expect(draft.revisions[0]!.documents[0]!.text).toContain(b!.spec.title);
    // The existing compile step accepts it, and nothing is published, staged or activated by approving.
    const validated = await command(w, w.owner, "configDraft.validate", "validate-a", { draftId });
    expect(validated.accepted).toBe(true);
    expect((await read()).validations[0]).toMatchObject({ status: "passed" });
    expect(releases(w)).toEqual(before);
    const afterApprove = (await proposals(w)).find((entry) => entry.proposalId === b!.proposalId)!;
    expect(afterApprove).toMatchObject({ state: "approved", draftId, selfReviewed: true, reason: "Worth repeating" });
    // A retry of the same decision returns the same draft instead of opening another.
    const retried = await command(w, w.owner, "play.proposal.review", "approve-a", { proposalId: b!.proposalId, decision: "approve", reason: "Worth repeating" });
    expect(retried.resourceId).toBe(draftId);

    const rejected = await command(w, w.owner, "play.proposal.review", "reject-b", { proposalId: a!.proposalId, decision: "reject", reason: "One-off" });
    expect(rejected.accepted).toBe(true);
    expect((await proposals(w)).find((entry) => entry.proposalId === a!.proposalId)).toMatchObject({ state: "rejected", reason: "One-off" });
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM config_drafts").get()).toEqual({ n: 1 });
    expect((await summary(w))["awaitingReview"]).toBe(2);
    await expect(command(w, w.owner, "play.proposal.review", "again", { proposalId: a!.proposalId, decision: "approve", reason: "Changed my mind" })).rejects.toThrow(/already rejected/u);
  });

  it("an operator can propose but only someone who may author configuration can approve", async () => {
    world = setupWorld();
    const w = world;
    const id = await achievedMission(w, "scope", { title: "Quarterly churn report", intent: "Analyse churn", criteria: ["causes named"] });
    seedHuman(w.brain, w.org, "operator-9");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'operator-9', 'operator', 1, 'owner-1', ?)").run(w.workspaceId, w.org, w.brain.store.now());
    const operator = w.actor("operator-9", w.workspaceId);
    expect((await command(w, operator, "play.propose", "op-prop", { missionId: id })).accepted).toBe(true);
    const [proposal] = await proposals(w);
    await expect(command(w, operator, "play.proposal.review", "op-review", { proposalId: proposal!.proposalId, decision: "approve", reason: "Looks good" })).rejects.toThrow();
    expect((await proposals(w))[0]!.state).toBe("proposed");
  });
});
