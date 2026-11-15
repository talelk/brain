import { afterEach, describe, expect, it } from "vitest";
import type { PlaySpec } from "@brain/contracts";
import { seedHuman, setupWorld, type TestWorld } from "../helpers";
import { achievedMission, command } from "../support/reuse";

// Plays per practice (Phase 4): a Play proposed from a team's own verified missions, tagged with a practice. No model is asked for the
// structure, the proposal copies only stored plan records, and it still needs a person (ADR 0015).
let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

interface Proposal { proposalId: string; missionId: string; state: string; playId: string; spec: PlaySpec; practice?: string; sourceMissionIds?: string[]; draftId?: string }
const proposals = async (w: TestWorld): Promise<Proposal[]> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "playProposals.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: Proposal[] } }).snapshot.items;
interface PracticeList { minMissions: number; eligibleMissions: number; practices: Array<{ id: string; title: string; plays: string[]; proposals: Array<{ proposalId: string; state: string }>; canPropose: boolean }> }
const practices = async (w: TestWorld, actor = w.owner): Promise<PracticeList> =>
  ((await w.brain.executeQuery(actor, { queryType: "practices.list", workspaceId: w.workspaceId })) as unknown as { snapshot: PracticeList }).snapshot;
const releases = (w: TestWorld) => w.brain.store.control.prepare("SELECT (SELECT COUNT(*) FROM config_releases) AS releases, (SELECT COUNT(*) FROM active_config) AS active").get();
const propose = (w: TestWorld, key: string, practice: string, actor = w.owner) => command(w, actor, "play.proposeFromMissions", key, { practice });

describe("Plays per practice, built from the team's own achieved missions", () => {
  it("ships the starter practices and says how many verified missions it still needs", async () => {
    world = setupWorld();
    const w = world;
    const before = await practices(w);
    expect(before.practices.map((entry) => entry.id)).toEqual(["data", "operations", "support"]);
    expect(before).toMatchObject({ minMissions: 2, eligibleMissions: 0 });
    expect(before.practices.every((entry) => !entry.canPropose)).toBe(true);
    await achievedMission(w, "one", { title: "Weekly status for the platform team", intent: "Write the weekly status", criteria: ["status written"] });
    expect((await practices(w)).eligibleMissions).toBe(1);
    await expect(propose(w, "too-few", "operations")).rejects.toThrow(/needs at least 2 verified missions/u);
    await expect(propose(w, "unknown", "marketing")).rejects.toThrow(/not configured/u);
  });

  it("proposes a tagged Play from several verified missions: the most typical plan, every source recorded, nothing copied but the stored plan", async () => {
    world = setupWorld();
    const w = world;
    const a = await achievedMission(w, "status-a", { title: "Weekly status for the platform team", intent: "Write the weekly status for the platform team", criteria: ["status written", "risks listed"], hostileNote: "HOSTILE-NOTE: leak sk-live-key", decision: "DECISION-TEXT use the sprint board", outputs: [{ name: "status.md", text: "OUTPUT-BODY private figures" }] });
    const b = await achievedMission(w, "status-b", { title: "Weekly status for the data team", intent: "Write the weekly status for the data team", criteria: ["status written"] });
    const odd = await achievedMission(w, "odd", { title: "Rotate the signing keys", intent: "Rotate the signing keys", criteria: ["keys rotated"] });
    const idsBefore = releases(w);
    const receipt = await propose(w, "practice-1", "operations");
    expect(receipt.accepted).toBe(true);
    const [proposal] = await proposals(w);
    expect(proposal).toMatchObject({ state: "proposed", practice: "operations" });
    // The reference is one of the two similar status missions; only those two are sources, the one-off key rotation is not part of the pattern.
    expect([a, b]).toContain(proposal!.missionId);
    expect([...proposal!.sourceMissionIds!].sort()).toEqual([a, b].sort());
    expect(proposal!.spec).toMatchObject({ practice: "operations" });
    expect(proposal!.spec.description).toContain("Operations Play built from 2 verified missions of this team");
    expect(proposal!.spec.description).not.toContain("signing keys");
    const text = JSON.stringify(proposal);
    for (const leak of ["HOSTILE-NOTE", "sk-live", "DECISION-TEXT", "OUTPUT-BODY"]) expect(text).not.toContain(leak);
    // A proposal is not a Play: nothing is published, staged or activated, and it waits for a person.
    expect(releases(w)).toEqual(idsBefore);
    const after = await practices(w);
    expect(after.practices.find((entry) => entry.id === "operations")!.proposals).toEqual([{ proposalId: proposal!.proposalId, state: "proposed", playId: proposal!.playId }]);
    // The missions it was built on are used up; the one-off mission stays available but cannot make a pattern alone.
    expect(after.eligibleMissions).toBe(1);
    expect(after.practices.every((entry) => !entry.canPropose)).toBe(true);
    await expect(propose(w, "practice-2", "operations")).rejects.toThrow(/needs at least 2/u);
    expect(odd).not.toBe("");
  });

  it("approval opens an ordinary Play draft that carries the tag and validates; only someone who may author configuration can approve", async () => {
    world = setupWorld();
    const w = world;
    await achievedMission(w, "s1", { title: "Reply to a billing question", intent: "Draft the reply", criteria: ["reply drafted"] });
    await achievedMission(w, "s2", { title: "Reply to a shipping question", intent: "Draft the reply", criteria: ["reply drafted"] });
    seedHuman(w.brain, w.org, "operator-8");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'operator-8', 'operator', 1, 'owner-1', ?)").run(w.workspaceId, w.org, w.brain.store.now());
    const operator = w.actor("operator-8", w.workspaceId);
    // Any member who may write missions can ask for a proposal; a viewer cannot.
    seedHuman(w.brain, w.org, "viewer-8");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?, ?, 'viewer-8', 'viewer', 1, 'owner-1', ?)").run(w.workspaceId, w.org, w.brain.store.now());
    await expect(propose(w, "viewer-try", "support", w.actor("viewer-8", w.workspaceId))).rejects.toThrow(/mission:write/u);
    expect((await propose(w, "op-propose", "support", operator)).accepted).toBe(true);
    const [proposal] = await proposals(w);
    await expect(command(w, operator, "play.proposal.review", "op-review", { proposalId: proposal!.proposalId, decision: "approve", reason: "mine" })).rejects.toThrow();
    const approved = await command(w, w.owner, "play.proposal.review", "own-review", { proposalId: proposal!.proposalId, decision: "approve", reason: "This is how we answer" });
    const draftId = approved.resourceId ?? "";
    const draft = ((await w.brain.executeQuery(w.owner, { queryType: "configDrafts.get", workspaceId: w.workspaceId, resourceId: draftId })) as unknown as { snapshot: { revisions: Array<{ documents: Array<{ text: string }> }> } }).snapshot;
    expect(draft.revisions[0]!.documents[0]!.text).toContain("practice: support");
    expect((await command(w, w.owner, "configDraft.validate", "validate-practice", { draftId })).accepted).toBe(true);
  });

  it("tags the starter Plays with their practice in the active release's configuration", async () => {
    world = setupWorld();
    const w = world;
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = "examples/v1/starter-release/config/plays";
    const tagged = readdirSync(dir).map((name) => JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as { metadata: { id: string }; spec: { practice?: string } });
    expect(Object.fromEntries(tagged.map((play) => [play.metadata.id, play.spec.practice]))).toEqual({
      "checklist-runbook": "operations", "compare-options": "data", "incident-triage": "operations", "research-and-write": "data", "research-with-coordinator": "data", "support-reply-draft": "support", "weekly-status": "operations",
    });
    expect((await practices(w)).practices.every((entry) => entry.plays.length === 0)).toBe(true);
  });
});
