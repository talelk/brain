import { afterEach, describe, expect, it } from "vitest";
import type { AuditEntry } from "@brain/contracts";
import { DIGEST_A } from "../helpers";
import { advance, bearer, closeWorlds, command, currentTimeMs, missionOf, register, run, running, startedMission as started, type World } from "../support/machine-session";

// ADR 0032: a session acts as its own machine principal, recorded as acting for the mission owner. The credential lives as long as the
// attempt that holds it. Everything here is reached through commands and the runner protocol, never through table writes.

afterEach(closeWorlds);

const audit = async (w: World): Promise<AuditEntry[]> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "audit.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: AuditEntry[] } }).snapshot.items;
const startedBy = (w: World) => (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT actor_id FROM run_inputs ORDER BY rowid LIMIT 1").get() as { actor_id: string }).actor_id;

describe("a session acts as its own machine principal (ADR 0032)", () => {
  it("auto-start dispatches as the assigned member's principal, never as the mission owner", async () => {
    const { w, missionId } = await started();
    const principal = startedBy(w);
    expect(principal).toBe(`agent:${missionId}:pi`);
    expect(principal).not.toBe(w.owner.actorId);
    const receipt = w.brain.store.control.prepare("SELECT actor_id FROM command_idempotency WHERE command_type='workflow.dispatch'").get() as { actor_id: string };
    expect(receipt.actor_id).toBe(principal);
    // A machine principal is not a person: it never shows up among the people who can open the workspace.
    const members = (await w.brain.executeQuery(w.owner, { queryType: "members.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: Array<{ principalId: string }> } };
    expect(members.snapshot.items.map((member) => member.principalId)).not.toContain(principal);
  });

  it("the attempt's credential acts as that principal, recorded as acting for the owner, and its commands are attributed in the audit trail", async () => {
    const { w, missionId, runner, workItemId } = await started();
    const offer = running(w, runner, "act");
    const { principalId, credential } = w.brain.jobProtocol.sessionCredential(runner, offer.attemptId);
    expect(principalId).toBe(`agent:${missionId}:pi`);
    const identity = await w.brain.resolveActor(bearer(credential), w.workspaceId);
    expect(identity.actor).toMatchObject({ kind: "agent", actorId: principalId, delegatedBy: w.owner.actorId, missionId, memberId: "pi", workspaceId: w.workspaceId, authMethod: "machine-credential" });
    expect(identity.actor.scopes).toEqual(["mission:write", "workspace:read"]);
    // A machine is never taken for a person: no human session, no step-up, no approval.
    expect(identity.humanSession).toBeNull();
    expect(() => w.brain.stepUp.createChallenge(identity, "unknown", DIGEST_A)).toThrow(/human/u);

    const receipt = (await w.brain.executeCommand(identity.actor, command(w, "workItem.comment", "agent-comment", { workItemId, text: "Found the cause" }), "corr-1")).receipt;
    expect(receipt.accepted).toBe(true);
    const entry = (await audit(w)).find((item) => item.action === "workItem.commented");
    expect(entry).toMatchObject({ actorId: principalId, actorKind: "agent", actingFor: w.owner.actorId, attemptId: offer.attemptId });
    expect(w.brain.store.control.prepare("SELECT actor_id FROM command_idempotency WHERE command_id='cmd-agent-comment'").get()).toEqual({ actor_id: principalId });
    // The owner's own commands are still the owner's: nothing is attributed to a machine.
    await run(w, "workItem.comment", "owner-comment", { workItemId, text: "Thanks" });
    // The thread shows both. Only the person's comment is sent to the team as a message; a session's own comment is never sent back to anyone (#100).
    const thread = ((await w.brain.executeQuery(w.owner, { queryType: "workItemComments.list", workspaceId: w.workspaceId, resourceId: workItemId })) as unknown as { snapshot: { items: Array<{ authorId: string; authorKind: string; delivery?: string }> } }).snapshot.items;
    expect(thread.map((entry) => [entry.authorId, entry.authorKind, entry.delivery !== undefined])).toEqual([[principalId, "agent", false], [w.owner.actorId, "human", true]]);
    expect((await audit(w)).filter((item) => item.action === "workItem.commented" && item.actorId === principalId)).toHaveLength(1);
  });

  it("cannot exceed its scope: no verdict, no administration, no other mission, no other workspace, no mission of its own", async () => {
    const { w, missionId, runner } = await started();
    const other = (await run(w, "mission.create", "other-create", { title: "Another", intent: "Not this one", successCriteria: ["x"] })).resourceId ?? "";
    const otherPlan = (await run(w, "plan.propose", "other-plan", { missionId: other, origin: "manual", tasks: [{ id: "z", title: "Task z", criteria: ["z is done"], dependsOn: [] }] })).resourceId ?? "";
    await run(w, "plan.confirm", "other-confirm", { planVersionId: otherPlan }, (await missionOf(w, other)).version);
    const otherItem = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id FROM work_items WHERE mission_id=?").get(other) as { id: string }).id;
    w.brain.createWorkspace(w.owner, { workspaceId: "ws-second", slug: "second" });
    const offer = running(w, runner, "scope");
    const { credential } = w.brain.jobProtocol.sessionCredential(runner, offer.attemptId);
    const identity = await w.brain.resolveActor(bearer(credential), w.workspaceId);
    const attempt = (commandType: string, key: string, payload: Record<string, unknown>, workspaceId = w.workspaceId) => w.brain.executeCommand(identity.actor, command(w, commandType, key, payload, workspaceId), "corr");
    await expect(attempt("mission.verdict.record", "deny-verdict", { missionId, bundleDigest: DIGEST_A, outcome: "verified", findings: [] })).rejects.toThrow(/cannot run|missing scope/u);
    // Reading a pull request's state goes through the connection's credentials: only a person asks for it.
    await expect(attempt("pullRequest.refresh", "deny-refresh", { pullRequestId: "pr-any" })).rejects.toThrow(/cannot run|missing scope/u);
    await expect(attempt("mission.close", "deny-close", { missionId, outcome: "achieved" })).rejects.toThrow(/cannot run|missing scope/u);
    await expect(attempt("workspace.update", "deny-admin", { workspaceId: w.workspaceId, displayName: "Renamed", description: "", ownerId: w.owner.actorId, tags: [] })).rejects.toThrow(/cannot run|missing scope/u);
    await expect(attempt("mission.create", "deny-create", { title: "Mine", intent: "A session starts nothing", successCriteria: ["x"] })).rejects.toThrow(/its own mission/u);
    await expect(attempt("workItem.comment", "deny-other", { workItemId: otherItem, text: "Wandering" })).rejects.toThrow(/its own mission/u);
    await expect(attempt("workItem.comment", "deny-workspace", { workItemId: otherItem, text: "Wandering" }, "ws-second")).rejects.toThrow(/not found|its own/u);
    // The owner losing access to the workspace takes the principal's scopes with it: a machine never holds more than the person it acts for.
    const version = (w.brain.store.control.prepare("SELECT version FROM workspaces WHERE id=?").get(w.workspaceId) as { version: number }).version;
    await run(w, "member.revoke", "owner-leaves", { principalId: w.owner.actorId, role: "workspace-lead", reason: "left the team" }, version);
    const missionItem = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string }).id;
    await expect(w.brain.resolveActor(bearer(credential), w.workspaceId).then((later) => w.brain.executeCommand(later.actor, command(w, "workItem.comment", "deny-owner-gone", { workItemId: missionItem, text: "Late" }), "corr"))).rejects.toThrow(/missing scope|not found/u);
  });

  it("stops working when the attempt ends", async () => {
    const { w, runner } = await started();
    const offer = running(w, runner, "end");
    const { credential } = w.brain.jobProtocol.sessionCredential(runner, offer.attemptId);
    await expect(w.brain.resolveActor(bearer(credential), w.workspaceId)).resolves.toBeTruthy();
    w.brain.jobProtocol.complete(runner, offer.attemptId, { result: "failed", jobFence: offer.jobFence, cleanupConfirmed: true, output: { reason: "stopped for the test" } });
    await expect(w.brain.resolveActor(bearer(credential), w.workspaceId)).rejects.toThrow(/ended|revoked/u);
    expect(w.brain.store.control.prepare("SELECT revoked_at_ms FROM machine_sessions").all()).toEqual([{ revoked_at_ms: currentTimeMs() }]);
    expect(() => w.brain.jobProtocol.sessionCredential(runner, offer.attemptId)).toThrow();
  });

  it("stops working when its fence moves, and the next attempt of the same member gets a fresh credential for the same principal", async () => {
    const { w, runner } = await started();
    const first = running(w, runner, "fence-1");
    const old = w.brain.jobProtocol.sessionCredential(runner, first.attemptId);
    // The runner stops renewing; the lease lapses and the platform takes the attempt back, so the job is offered again under a new fence.
    advance(61_000);
    w.brain.jobProtocol.heartbeat(runner, { sequence: 1, health: "healthy" });
    await expect(w.brain.resolveActor(bearer(old.credential), w.workspaceId)).rejects.toThrow(/ended|revoked/u);
    w.brain.jobProtocol.expireLeases();
    const second = running(w, runner, "fence-2");
    expect(second.jobFence).toBeGreaterThan(first.jobFence);
    await expect(w.brain.resolveActor(bearer(old.credential), w.workspaceId)).rejects.toThrow(/ended|revoked/u);
    const next = w.brain.jobProtocol.sessionCredential(runner, second.attemptId);
    expect(next.principalId).toBe(old.principalId);
    await expect(w.brain.resolveActor(bearer(next.credential), w.workspaceId)).resolves.toBeTruthy();
  });

  it("another runner cannot mint a credential for the attempt", async () => {
    const { w, runner } = await started();
    const offer = running(w, runner, "foreign");
    const stranger = register(w, "runner-stranger");
    expect(() => w.brain.jobProtocol.sessionCredential(stranger, offer.attemptId)).toThrow(/another runner/u);
  });
});
