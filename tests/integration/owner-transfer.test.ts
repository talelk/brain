import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, AttentionItem, AuditEntry } from "@brain/contracts";
import { seedHuman } from "../helpers";
import { advance, bearer, closeWorlds, command, confirmedMission, freshWorld, missionOf, run, running, task, type World } from "../support/machine-session";

// Spec #90, ticket #117: a mission's owner or a workspace administrator hands it to another workspace member. State is reached through
// commands and the runner protocol; the one thing read directly is the Governor's own event record.

afterEach(closeWorlds);

type Role = "viewer" | "operator" | "workspace-lead";
const workspaceVersion = (w: World) => (w.brain.store.control.prepare("SELECT version FROM workspaces WHERE id=?").get(w.workspaceId) as { version: number }).version;
/** A signed-in person with one role in the workspace, granted through the member.grant command. */
async function person(w: World, principalId: string, role: Role | null): Promise<ActorContext> {
  seedHuman(w.brain, w.org, principalId);
  if (role) await run(w, "member.grant", `grant-${principalId}`, { principalId, role, reason: "test" }, workspaceVersion(w));
  return w.actor(principalId, w.workspaceId);
}
const as = async (w: World, actor: ActorContext, type: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) =>
  (await w.brain.executeCommand(actor, { ...(command(w, type, key, payload) as object), ...(expectedVersion ? { expectedVersion } : {}) } as never, key)).receipt;
const query = async <T>(w: World, actor: ActorContext, queryType: string, resourceId?: string): Promise<T> =>
  ((await w.brain.executeQuery(actor, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) })) as unknown as { snapshot: T }).snapshot;
const ownerOf = async (w: World, missionId: string) => (await missionOf(w, missionId)).ownerId;
const transfer = (w: World, actor: ActorContext, missionId: string, newOwnerId: string, key: string) => as(w, actor, "mission.owner.transfer", key, { missionId, newOwnerId });
const audit = async (w: World) => (await query<{ items: AuditEntry[] }>(w, w.owner, "audit.list")).items;

describe("mission owner transfer (#117)", () => {
  it("the owner hands the mission to another member; the audit trail names the old and the new owner", async () => {
    const { w } = freshWorld();
    const { missionId } = await confirmedMission(w);
    await person(w, "dana", "operator");
    const before = await missionOf(w, missionId);
    expect((await transfer(w, w.owner, missionId, "dana", "t1")).accepted).toBe(true);
    const after = await missionOf(w, missionId);
    expect(after.ownerId).toBe("dana");
    expect(after.version).toBe(before.version + 1);
    const entry = (await audit(w)).find((item) => item.action === "mission.ownerTransferred");
    expect(entry).toMatchObject({ actorId: w.owner.actorId, resourceId: missionId });
    expect(entry?.message).toMatch(/^Handed over from .+ to dana$/u);
    const recorded = JSON.parse((w.brain.store.control.prepare("SELECT payload_json FROM events WHERE event_type='mission.ownerTransferred'").get() as { payload_json: string }).payload_json) as { from: string; to: string };
    expect([recorded.from, recorded.to]).toEqual([w.owner.actorId, "dana"]);
  });

  it("only the owner and workspace administrators may hand a mission over", async () => {
    const { w } = freshWorld();
    const { missionId } = await confirmedMission(w);
    const dana = await person(w, "dana", "operator");
    const eve = await person(w, "eve", "operator");
    const viewer = await person(w, "vic", "viewer");
    const lead = await person(w, "lena", "workspace-lead");
    await expect(transfer(w, eve, missionId, "eve", "t-eve")).rejects.toThrow(/owner or a workspace administrator/u);
    await expect(transfer(w, viewer, missionId, "dana", "t-viewer")).rejects.toThrow(/cannot run|missing scope/u);
    expect(await ownerOf(w, missionId)).toBe(w.owner.actorId);
    // An administrator who does not own the mission may hand it over.
    expect((await transfer(w, lead, missionId, "dana", "t-lead")).accepted).toBe(true);
    // Now dana owns it: she may hand it on; a plain operator who is not the owner still may not.
    await expect(transfer(w, eve, missionId, "eve", "t-eve-2")).rejects.toThrow(/owner or a workspace administrator/u);
    expect((await transfer(w, dana, missionId, "eve", "t-dana")).accepted).toBe(true);
    await expect(transfer(w, dana, missionId, "dana", "t-dana-back")).rejects.toThrow(/owner or a workspace administrator/u);
    expect(await ownerOf(w, missionId)).toBe("eve");
  });

  it("the new owner must be an active member who can stand behind the mission's sessions", async () => {
    const { w } = freshWorld();
    const { missionId } = await confirmedMission(w);
    await person(w, "vic", "viewer");
    await person(w, "nora", null);
    await person(w, "gus", "operator");
    await run(w, "member.revoke", "gus-leaves", { principalId: "gus", role: "operator", reason: "left" }, workspaceVersion(w));
    await expect(transfer(w, w.owner, missionId, "vic", "n-viewer")).rejects.toThrow(/missing mission:write/u);
    await expect(transfer(w, w.owner, missionId, "nora", "n-nonmember")).rejects.toThrow(/active member/u);
    await expect(transfer(w, w.owner, missionId, "gus", "n-revoked")).rejects.toThrow(/active member/u);
    await expect(transfer(w, w.owner, missionId, "nobody", "n-unknown")).rejects.toThrow(/active member/u);
    await expect(transfer(w, w.owner, missionId, w.owner.actorId, "n-self")).rejects.toThrow(/already belongs/u);
    expect(await ownerOf(w, missionId)).toBe(w.owner.actorId);
  });

  it("the hand-over dialog offers exactly the members who could take over, to an operator who owns the mission too", async () => {
    const { w } = freshWorld();
    await confirmedMission(w);
    const dana = await person(w, "dana", "operator");
    await person(w, "vic", "viewer");
    await person(w, "nora", null);
    const offered = (await query<{ items: Array<{ principalId: string }> }>(w, dana, "missionOwnerCandidates.list")).items.map((entry) => entry.principalId);
    expect(offered).toContain(w.owner.actorId);
    expect(offered).toContain("dana");
    expect(offered).not.toContain("vic");
    expect(offered).not.toContain("nora");
    const viewer = await person(w, "wes", "viewer");
    await expect(query(w, viewer, "missionOwnerCandidates.list")).rejects.toThrow(/only people who work on missions/u);
  });

  it("a closed mission is not handed over, and a stale version is refused", async () => {
    const { w } = freshWorld();
    const { missionId } = await confirmedMission(w);
    await person(w, "dana", "operator");
    const stale = (await missionOf(w, missionId)).version;
    await run(w, "mission.pause", "pause", { missionId }, stale);
    await expect(as(w, w.owner, "mission.owner.transfer", "n-stale", { missionId, newOwnerId: "dana" }, stale)).rejects.toThrow(/version|stale|conflict/iu);
    await run(w, "mission.close", "close", { missionId, outcome: "ended" }, (await missionOf(w, missionId)).version);
    await expect(transfer(w, w.owner, missionId, "dana", "n-closed")).rejects.toThrow(/closed/u);
    expect(await ownerOf(w, missionId)).toBe(w.owner.actorId);
  });

  it("attention items and notifications follow the new owner, under the new owner's own per-mission throttle", async () => {
    const { w } = freshWorld();
    const { missionId } = await confirmedMission(w);
    const dana = await person(w, "dana", "operator");
    const inbox = async (actor: ActorContext) => (await query<{ items: Array<{ itemId: string }> }>(w, actor, "notifications.list")).items.map((entry) => entry.itemId);
    const propose = (key: string, id: string) => run(w, "plan.propose", key, { missionId, origin: "manual", tasks: [task("a"), task(id)] });
    // A plan proposal waits for a person: the owner is told, nobody else.
    await propose("p1", "b");
    w.brain.notifyAttention();
    const proposal = (await query<{ items: AttentionItem[] }>(w, w.owner, "attention.list")).items.find((item) => item.kind === "plan-proposal")!;
    expect(await inbox(w.owner)).toContain(proposal.id);
    expect(await inbox(dana)).toEqual([]);
    await transfer(w, w.owner, missionId, "dana", "t1");
    w.brain.notifyAttention();
    // The same open item now reaches the new owner, in her own inbox and under her own window; it is still in everyone's Needs you.
    expect(await inbox(dana)).toContain(proposal.id);
    expect((await query<{ items: AttentionItem[] }>(w, dana, "attention.list")).items.map((item) => item.id)).toContain(proposal.id);
    // A later item of the mission goes to the new owner only: the previous owner is not told again.
    const told = (await inbox(w.owner)).length;
    const later = (await propose("p2", "c")).resourceId;
    advance(16 * 60_000);
    w.brain.notifyAttention();
    expect((await inbox(w.owner)).length).toBe(told);
    expect(await inbox(dana)).toContain(`proposal:${later}`);
  });

  it("a mission's sessions act for the new owner: a running attempt keeps its credential and fence, and acts for her from then on", async () => {
    const { w, runner } = freshWorld();
    const { missionId, workItemId } = await confirmedMission(w);
    await person(w, "dana", "operator");
    const offer = running(w, runner, "own-1");
    const { principalId, credential } = w.brain.jobProtocol.sessionCredential(runner, offer.attemptId);
    expect((await w.brain.resolveActor(bearer(credential), w.workspaceId)).actor.delegatedBy).toBe(w.owner.actorId);
    await transfer(w, w.owner, missionId, "dana", "t1");
    // Same principal, same credential, same fence; it now acts for dana, with what dana may do.
    const after = await w.brain.resolveActor(bearer(credential), w.workspaceId);
    expect(after.actor).toMatchObject({ actorId: principalId, delegatedBy: "dana", missionId, scopes: ["mission:write", "workspace:read"] });
    expect(w.brain.store.control.prepare("SELECT revoked_at_ms FROM machine_sessions WHERE attempt_id=?").get(offer.attemptId)).toEqual({ revoked_at_ms: null });
    expect((await as(w, after.actor, "workItem.comment", "agent-comment", { workItemId, text: "Working for the new owner" })).accepted).toBe(true);
    expect((await audit(w)).find((entry) => entry.action === "workItem.commented" && entry.actorId === principalId)).toMatchObject({ actorId: principalId, actingFor: "dana" });
    // A session never hands a mission over: that is a person's decision.
    await expect(as(w, after.actor, "mission.owner.transfer", "agent-transfer", { missionId, newOwnerId: w.owner.actorId })).rejects.toThrow(/cannot run|missing scope/u);
    // The lease lapses and the next attempt starts under a new fence: a fresh credential for the same principal, acting for the new owner.
    advance(61_000);
    w.brain.jobProtocol.heartbeat(runner, { sequence: 1, health: "healthy" });
    await expect(w.brain.resolveActor(bearer(credential), w.workspaceId)).rejects.toThrow(/ended|revoked/u);
    w.brain.jobProtocol.expireLeases();
    const second = running(w, runner, "own-2");
    expect(second.jobFence).toBeGreaterThan(offer.jobFence);
    const next = w.brain.jobProtocol.sessionCredential(runner, second.attemptId);
    expect(next.principalId).toBe(principalId);
    expect((await w.brain.resolveActor(bearer(next.credential), w.workspaceId)).actor).toMatchObject({ actorId: principalId, delegatedBy: "dana" });
    await expect(w.brain.resolveActor(bearer(credential), w.workspaceId)).rejects.toThrow(/ended|revoked/u);
  });

  it("a new owner who later loses access leaves the mission's sessions holding nothing, until an administrator hands it on", async () => {
    const { w, runner } = freshWorld();
    const { missionId, workItemId } = await confirmedMission(w);
    await person(w, "dana", "operator");
    const offer = running(w, runner, "lose-1");
    const { credential } = w.brain.jobProtocol.sessionCredential(runner, offer.attemptId);
    await transfer(w, w.owner, missionId, "dana", "t1");
    await run(w, "member.revoke", "dana-leaves", { principalId: "dana", role: "operator", reason: "left" }, workspaceVersion(w));
    await expect(w.brain.resolveActor(bearer(credential), w.workspaceId).then((later) => as(w, later.actor, "workItem.comment", "late", { workItemId, text: "late" }))).rejects.toThrow(/missing scope|not found/u);
    expect(await ownerOf(w, missionId)).toBe("dana");
    expect((await transfer(w, w.owner, missionId, w.owner.actorId, "t2")).accepted).toBe(true);
    const back = await w.brain.resolveActor(bearer(credential), w.workspaceId);
    expect(back.actor.delegatedBy).toBe(w.owner.actorId);
  });
});
