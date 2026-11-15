import { afterEach, describe, expect, it } from "vitest";
import { sha256Digest, type ActorContext, type KnowledgeAsset, type MemoryQuery } from "@brain/contracts";
import { actorOf, ensureAgentPrincipal } from "../../apps/governor/src/modules/identity/index";
import { setupWorld, type TestWorld } from "../helpers";
import { achievedMission, command } from "../support/reuse";

// Spec #90, story 85 (#135): team and private memory scopes, through the Governor's command and query boundary with real people and
// real machine principals. Scope is checked on every read; a scope never widens without a person's review (ADR 0056).
let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

const QUARTERLY = { title: "Quarterly churn report", intent: "Analyse customer churn for the quarter and write a report with the three biggest causes", criteria: ["The report names the three biggest churn causes", "Every cause cites its data source"] };
const WORDS = "quarterly churn report causes";

const query = (w: TestWorld, text = WORDS): MemoryQuery => ({
  contractVersion: "brain.memory/v1", queryId: `q-${text}`, scope: { organizationId: w.org, visibility: "workspace", workspaceId: w.workspaceId }, query: text,
  sourceTypes: ["knowledge", "wiki"], limit: 8, maxChars: 4000,
});
/** What this reader finds when searching memory: the ids and the scope each hit reports. */
async function found(w: TestWorld, who: ActorContext, workspaceId = w.workspaceId): Promise<Array<{ sourceId: string; visibility: string }>> {
  const result = (await w.brain.searchMemoryAsync(who, workspaceId, query(w))) as unknown as { snapshot: { results: Array<{ sourceId: string; scope: { visibility: string } }> } };
  return result.snapshot.results.map((hit) => ({ sourceId: hit.sourceId, visibility: hit.scope.visibility }));
}
async function listed(w: TestWorld, who: ActorContext): Promise<KnowledgeAsset[]> {
  return ((await w.brain.executeQuery(who, { queryType: "knowledgeAssets.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: KnowledgeAsset[] } }).snapshot.items;
}
const ids = (hits: Array<{ sourceId: string }>): string[] => hits.map((hit) => hit.sourceId);

/** A second person with the review scope joins the workspace, so the producer can no longer review their own. */
function addReviewer(w: TestWorld, id: string): ActorContext {
  w.brain.ensurePrincipal(w.org, id, "human");
  w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?,?,?,'workspace-lead',1,'owner-1',?)").run(w.workspaceId, w.org, id, w.brain.store.now());
  return w.actor(id, w.workspaceId);
}
/** A member who can read the workspace but holds no review scope. */
function addReader(w: TestWorld, id: string): ActorContext {
  w.brain.ensurePrincipal(w.org, id, "human");
  w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES (?,?,?,'viewer',1,'owner-1',?)").run(w.workspaceId, w.org, id, w.brain.store.now());
  return w.actor(id, w.workspaceId);
}
/** The machine principal of one mission's session, acting for the mission's owner. */
function session(w: TestWorld, missionId: string): ActorContext {
  const binding = ensureAgentPrincipal(w.brain.store, { organizationId: w.org, workspaceId: w.workspaceId, missionId, memberId: null, actingFor: "owner-1" });
  return actorOf(binding, ["workspace:read"], "machine-credential");
}
const otherMission = async (w: TestWorld, key: string): Promise<string> =>
  (await command(w, w.owner, "mission.create", key, { title: `Unrelated ${key}`, intent: "Plan the offsite", successCriteria: ["done"] })).resourceId ?? "";

/** One mission's write-up, proposed and then approved at the given scope by the given reviewer. */
async function published(w: TestWorld, key: string, scope?: "private" | "team" | "workspace", reviewer: ActorContext = w.owner): Promise<{ asset: KnowledgeAsset; missionId: string }> {
  const missionId = await achievedMission(w, key, QUARTERLY);
  const asset = (await listed(w, w.owner)).find((entry) => entry.missionId === missionId)!;
  await command(w, reviewer, "knowledge.review", `${key}-approve`, { assetId: asset.assetId, decision: "approve", reason: "Reads correctly", ...(scope ? { scope } : {}) });
  return { asset: (await listed(w, w.owner)).find((entry) => entry.assetId === asset.assetId)!, missionId };
}

describe("private memory is the author's alone", () => {
  it("is found by its author only, on every read: search, lists, planner, reuse, sessions and counts", async () => {
    world = setupWorld();
    const w = world;
    const reviewer = addReviewer(w, "reviewer-2");
    const { asset, missionId } = await published(w, "priv", "private");
    expect(asset).toMatchObject({ state: "published", scope: "private" });
    expect(asset.selfReviewed).toBeUndefined();

    expect(await found(w, w.owner)).toEqual([{ sourceId: asset.assetId, visibility: "private" }]);
    // Another person with the review scope, a plain member, a session of the very mission it came from and one of another mission: nothing.
    const reader = addReader(w, "reader-3");
    for (const other of [reviewer, reader, session(w, missionId), session(w, await otherMission(w, "elsewhere"))]) expect(await found(w, other), other.actorId).toEqual([]);
    expect((await listed(w, reviewer)).map((entry) => entry.assetId)).not.toContain(asset.assetId);
    expect((await listed(w, reader)).map((entry) => entry.assetId)).not.toContain(asset.assetId);
    expect((await listed(w, w.owner)).map((entry) => entry.assetId)).toContain(asset.assetId);
    // A plan draft is read by the whole workspace and its agents, so it never carries one person's private memory, not even its author's.
    expect(w.brain.knowledgeHits(w.owner, w.workspaceId, WORDS, 5)).toEqual([]);
    // Reuse offers items to new missions, so a private record is never offered.
    expect(w.brain.reuse.search(w.owner, w.workspaceId, "quarterly churn report causes biggest").map((item) => item.itemRef)).not.toContain(`knowledge:${asset.assetId}`);
    // The workspace's counts are the workspace's knowledge.
    expect(((await w.brain.executeQuery(reviewer, { queryType: "library.summary", workspaceId: w.workspaceId })) as unknown as { snapshot: { publishedKnowledge: number } }).snapshot.publishedKnowledge).toBe(0);
  });

  it("does not follow the person into another workspace", async () => {
    world = setupWorld();
    const w = world;
    const { asset } = await published(w, "priv-ws", "private");
    w.brain.createWorkspace(w.owner, { workspaceId: "ws-two", slug: "two" });
    expect(ids(await found(w, w.actor("owner-1", "ws-two"), "ws-two"))).not.toContain(asset.assetId);
  });
});

describe("team memory belongs to the team of the mission it came from", () => {
  it("is read by that mission's owner, watchers and sessions, and by nobody else", async () => {
    world = setupWorld();
    const w = world;
    const reviewer = addReviewer(w, "reviewer-2");
    const { asset, missionId } = await published(w, "team", "team", reviewer);
    expect(asset).toMatchObject({ state: "published", scope: "team", reviewedBy: "reviewer-2" });

    expect(await found(w, w.owner)).toEqual([{ sourceId: asset.assetId, visibility: "team" }]);
    expect(ids(await found(w, session(w, missionId)))).toEqual([asset.assetId]);
    // A session of another mission of the same owner, the planner and a person outside the team see nothing, whatever they may review.
    expect(await found(w, session(w, await otherMission(w, "beta")))).toEqual([]);
    expect(await found(w, reviewer)).toEqual([]);
    expect(w.brain.knowledgeHits(w.owner, w.workspaceId, WORDS, 5)).toEqual([]);
    expect((await listed(w, reviewer)).map((entry) => entry.assetId)).not.toContain(asset.assetId);
    expect(w.brain.reuse.search(w.owner, w.workspaceId, "quarterly churn report causes biggest").map((item) => item.itemRef)).not.toContain(`knowledge:${asset.assetId}`);
    // Watching the mission makes someone part of its team.
    await command(w, reviewer, "mission.watch", "watch-1", { missionId, watch: true });
    expect(ids(await found(w, reviewer))).toEqual([asset.assetId]);
  });

  it("needs a mission to name and an author to keep it private for", async () => {
    world = setupWorld();
    const w = world;
    const missionId = await achievedMission(w, "needs", QUARTERLY);
    const asset = (await listed(w, w.owner)).find((entry) => entry.missionId === missionId)!;
    await expect(command(w, w.owner, "knowledge.review", "bad-scope", { assetId: asset.assetId, decision: "approve", reason: "ok", scope: "galaxy" })).rejects.toThrow();
  });
});

describe("a scope never widens without a review", () => {
  it("promotion is asked for by the author and decided by a different reviewer, who sees the record only for that", async () => {
    world = setupWorld();
    const w = world;
    const reviewer = addReviewer(w, "reviewer-2");
    const { asset } = await published(w, "promote", "private");
    // Nobody but the author can see it, so nobody else can decide anything about it.
    await expect(command(w, reviewer, "knowledge.scope.set", "blind", { assetId: asset.assetId, scope: "workspace", reason: "share it" })).rejects.toThrow(/not found/);
    // The author cannot widen it on their own: there has to be a request, and while another reviewer exists the author is never that reviewer.
    await expect(command(w, w.owner, "knowledge.scope.set", "no-request", { assetId: asset.assetId, scope: "workspace", reason: "mine" })).rejects.toThrow(/needs the author's request and a review/);
    await command(w, w.owner, "knowledge.scope.request", "ask", { assetId: asset.assetId, scope: "workspace" });
    // Asking changes nothing anyone reads.
    expect(await found(w, reviewer)).toEqual([]);
    await expect(command(w, w.owner, "knowledge.scope.set", "self", { assetId: asset.assetId, scope: "workspace", reason: "mine" })).rejects.toThrow(/another reviewer/);
    // The reviewer now sees the request (and only for review), and decides it.
    expect((await listed(w, reviewer)).find((entry) => entry.assetId === asset.assetId)).toMatchObject({ scope: "private", scopeRequested: "workspace" });
    expect(await found(w, reviewer)).toEqual([]);
    // Asking for one scope does not let a reviewer grant another.
    await expect(command(w, reviewer, "knowledge.scope.set", "other", { assetId: asset.assetId, scope: "team", reason: "different" })).rejects.toThrow(/request and a review/);
    await command(w, reviewer, "knowledge.scope.set", "approve", { assetId: asset.assetId, scope: "workspace", reason: "Useful to everyone" });
    expect((await listed(w, w.owner)).find((entry) => entry.assetId === asset.assetId)).toMatchObject({ scope: "workspace", reviewedBy: "reviewer-2" });
    expect((await listed(w, w.owner)).find((entry) => entry.assetId === asset.assetId)!.scopeRequested).toBeUndefined();
    expect(ids(await found(w, reviewer))).toEqual([asset.assetId]);
    expect(ids(await found(w, addReader(w, "reader-3")))).toEqual([asset.assetId]);
    expect(w.brain.knowledgeHits(w.owner, w.workspaceId, WORDS, 5).map((hit) => hit.sourceId)).toEqual([asset.assetId]);
  });

  it("a sole reviewer may review their own promotion, and it is marked self-reviewed (ADR 0007)", async () => {
    world = setupWorld();
    const w = world;
    const { asset } = await published(w, "sole", "private");
    await command(w, w.owner, "knowledge.scope.request", "ask-team", { assetId: asset.assetId, scope: "team" });
    await command(w, w.owner, "knowledge.scope.set", "ok-team", { assetId: asset.assetId, scope: "team", reason: "My team can use it" });
    expect((await listed(w, w.owner)).find((entry) => entry.assetId === asset.assetId)).toMatchObject({ scope: "team", selfReviewed: true });
    const hit = ((await w.brain.searchMemoryAsync(w.owner, w.workspaceId, query(w))) as unknown as { snapshot: { results: Array<{ selfReviewed?: boolean; scope: { visibility: string } }> } }).snapshot.results[0]!;
    expect(hit).toMatchObject({ selfReviewed: true, scope: { visibility: "team" } });
  });

  it("narrowing needs no review and takes effect at once, including for reuse", async () => {
    world = setupWorld();
    const w = world;
    const reader = addReader(w, "reader-3");
    const { asset } = await published(w, "narrow");
    expect(asset.scope).toBe("workspace");
    expect(ids(await found(w, reader))).toEqual([asset.assetId]);
    expect(w.brain.reuse.search(w.owner, w.workspaceId, "quarterly churn report causes biggest").map((item) => item.itemRef)).toContain(`knowledge:${asset.assetId}`);
    await command(w, w.owner, "knowledge.scope.set", "narrow-team", { assetId: asset.assetId, scope: "team", reason: "Only the team needs it" });
    expect(await found(w, reader)).toEqual([]);
    expect(w.brain.reuse.search(w.owner, w.workspaceId, "quarterly churn report causes biggest").map((item) => item.itemRef)).not.toContain(`knowledge:${asset.assetId}`);
    // Going back is a widening: it asks again.
    await expect(command(w, w.owner, "knowledge.scope.set", "widen-back", { assetId: asset.assetId, scope: "workspace", reason: "undo" })).rejects.toThrow(/request and a review/);
  });

  it("no other door widens it: not a republication, not a session, not a request from someone else", async () => {
    world = setupWorld();
    const w = world;
    const reviewer = addReviewer(w, "reviewer-2");
    const { asset, missionId } = await published(w, "doors", "team", reviewer);
    // Publishing the same source again at a wider scope is refused at the store and through the command.
    expect(() => w.brain.memory.publish({ organizationId: w.org, workspaceId: w.workspaceId, sourceId: asset.assetId, text: asset.content, sourceType: "knowledge", status: "reviewed" })).toThrow(/another scope/);
    expect(() => w.brain.memory.publish({ organizationId: w.org, workspaceId: null, sourceId: asset.assetId, text: asset.content, sourceType: "knowledge", status: "reviewed" })).toThrow(/another scope/);
    const bytes = Buffer.from(asset.content, "utf8");
    const digest = sha256Digest(bytes);
    const up = w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: digest, expectedBytes: bytes.length }) as unknown as { uploadId: string };
    w.brain.putUpload(w.owner, up.uploadId, bytes);
    const evidence = Buffer.from("evidence: reviewed", "utf8");
    const evDigest = sha256Digest(evidence);
    w.brain.putUpload(w.owner, (w.brain.initUpload(w.owner, { workspaceId: w.workspaceId, expectedDigest: evDigest, expectedBytes: evidence.length }) as unknown as { uploadId: string }).uploadId, evidence);
    const profile = ((JSON.parse(w.brain.activeRelease(w.org)!.manifest) as { manifest: { documents: Array<{ id: string; digest: string }> } }).manifest.documents)[0]!;
    await expect(command(w, w.owner, "memory.publish", "republish", {
      candidateId: asset.assetId, sourceWorkspaceId: w.workspaceId, targetScope: { organizationId: w.org, visibility: "workspace", workspaceId: w.workspaceId },
      content: { artifactId: "unused", digest, bytes: bytes.length, mediaType: "text/plain", classification: "internal" }, evidenceDigests: [evDigest], reviewerId: "reviewer-2",
      redactionProfile: { id: profile.id, digest: profile.digest },
    })).rejects.toThrow(/another scope/);
    expect((await listed(w, w.owner)).find((entry) => entry.assetId === asset.assetId)!.scope).toBe("team");
    // A session may not run the scope commands at all.
    await expect(command(w, session(w, missionId), "knowledge.scope.set", "bot", { assetId: asset.assetId, scope: "workspace", reason: "widen" })).rejects.toThrow();
    await expect(command(w, session(w, missionId), "knowledge.scope.request", "bot-ask", { assetId: asset.assetId, scope: "workspace" })).rejects.toThrow();
    // Only the author asks, and only for something wider than it has.
    const lead = addReviewer(w, "reviewer-3");
    await command(w, lead, "mission.watch", "lead-watch", { missionId, watch: true });
    await expect(command(w, lead, "knowledge.scope.request", "not-author", { assetId: asset.assetId, scope: "workspace" })).rejects.toThrow(/only the author/);
    await expect(command(w, w.owner, "knowledge.scope.request", "not-wider", { assetId: asset.assetId, scope: "team" })).rejects.toThrow(/not wider/);
    expect(await found(w, addReader(w, "reader-4"))).toEqual([]);
  });
});

describe("reviewed publication into team and private scopes", () => {
  it("team and private targets store and search for the right readers; a private target is for the publisher only", async () => {
    world = setupWorld();
    const w = world;
    addReviewer(w, "reviewer-2");
    const missionId = await otherMission(w, "teamdoc");
    const publish = async (key: string, candidateId: string, targetScope: Record<string, unknown>, actor: ActorContext = w.owner) => {
      const text = `golden rollout checklist ${key}`;
      const bytes = Buffer.from(text, "utf8");
      const digest = sha256Digest(bytes);
      w.brain.putUpload(actor, (w.brain.initUpload(actor, { workspaceId: w.workspaceId, expectedDigest: digest, expectedBytes: bytes.length }) as unknown as { uploadId: string }).uploadId, bytes);
      const evidence = Buffer.from(`evidence ${key}`, "utf8");
      const evDigest = sha256Digest(evidence);
      w.brain.putUpload(actor, (w.brain.initUpload(actor, { workspaceId: w.workspaceId, expectedDigest: evDigest, expectedBytes: evidence.length }) as unknown as { uploadId: string }).uploadId, evidence);
      const profile = ((JSON.parse(w.brain.activeRelease(w.org)!.manifest) as { manifest: { documents: Array<{ id: string; digest: string }> } }).manifest.documents)[0]!;
      return command(w, actor, "memory.publish", key, { candidateId, sourceWorkspaceId: w.workspaceId, targetScope, content: { artifactId: "u", digest, bytes: bytes.length, mediaType: "text/plain", classification: "internal" }, evidenceDigests: [evDigest], reviewerId: "reviewer-2", redactionProfile: { id: profile.id, digest: profile.digest } });
    };
    await publish("team-doc", "cand-team", { organizationId: w.org, visibility: "team", teamId: missionId });
    await publish("priv-doc", "cand-priv", { organizationId: w.org, visibility: "private", workspaceId: w.workspaceId, ownerId: "owner-1" });
    const golden = { ...query(w, "golden rollout checklist"), sourceTypes: ["wiki", "knowledge"] } as MemoryQuery;
    const read = async (who: ActorContext) => ((await w.brain.searchMemoryAsync(who, w.workspaceId, golden)) as unknown as { snapshot: { results: Array<{ sourceId: string }> } }).snapshot.results.map((hit) => hit.sourceId).sort();
    // The owner of the mission (its team) and the author find both; the session of that mission finds the team's only; others find nothing.
    expect(await read(w.owner)).toEqual(["cand-priv", "cand-team"]);
    expect(await read(session(w, missionId))).toEqual(["cand-team"]);
    expect(await read(session(w, await otherMission(w, "gamma")))).toEqual([]);
    expect(await read(w.actor("reviewer-2", w.workspaceId))).toEqual([]);
    // Nobody can plant private memory in someone else's view, or name a team that is not a mission here.
    await expect(publish("plant", "cand-plant", { organizationId: w.org, visibility: "private", workspaceId: w.workspaceId, ownerId: "reviewer-2" })).rejects.toThrow(/yourself only/);
    await expect(publish("ghost", "cand-ghost", { organizationId: w.org, visibility: "team", teamId: "mission-ghost" })).rejects.toThrow(/not in the source workspace/);
  });
});
