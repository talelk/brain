import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, BrainSession, Delegation, SessionContext, WorkItem } from "@brain/contracts";
import { DIGEST_A } from "../helpers";
import { delegatingStarter, fixtureStarter } from "../support/starter";
import { bearer, closeWorlds, command, missionOf, run, running, startedMission, type Offer, type Runner, type World } from "../support/machine-session";

// Delegated sessions run (ADR 0053): a child session of a running session is its own run of the same mission, admitted, placed and claimed
// like any task's, and what it does reaches the parent's task as a handoff, never as a run of that task. Everything is reached through
// commands, the runner protocol and queries; the one table read is the job queue, which is the claim's own answer.

afterEach(closeWorlds);

const db = (w: World) => w.brain.store.workspaceDb(w.workspaceId, w.org);
const query = async <T>(w: World, queryType: string, resourceId?: string, as: ActorContext = w.owner): Promise<T> =>
  ((await w.brain.executeQuery(as, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) } as never)) as unknown as { snapshot: T }).snapshot;
const delegations = async (w: World): Promise<Delegation[]> => (await query<{ items: Delegation[] }>(w, "delegations.list")).items;
const delegationOf = async (w: World, id: string): Promise<Delegation> => (await delegations(w)).find((entry) => entry.delegationId === id)!;
const sessionOf = (w: World, id: string) => query<BrainSession>(w, "session.get", id);
const jobsOf = (w: World, runId: string) => w.brain.store.control.prepare("SELECT id, step_id AS step, state, queue_reason AS reason FROM jobs WHERE workflow_run_id=? ORDER BY created_at_ms, id").all(runId) as Array<{ id: string; step: string; state: string; reason: string | null }>;
const taskItem = (w: World, id: string) => query<WorkItem>(w, "workItems.get", id);

/** The identity a running attempt's credential speaks for: its member's machine principal, as the runner's Brain tools use it. */
async function sessionActor(w: World, runner: Runner, offer: Offer): Promise<{ actor: ActorContext; sessionId: string }> {
  const { credential } = w.brain.jobProtocol.sessionCredential(runner, offer.attemptId);
  const identity = await w.brain.resolveActor(bearer(credential), w.workspaceId);
  const session = (await query<{ items: BrainSession[] }>(w, "sessions.list")).items.find((entry) => entry.attemptId === offer.attemptId)!;
  return { actor: identity.actor, sessionId: session.sessionId };
}

const delegate = (w: World, actor: ActorContext, key: string, payload: Record<string, unknown>) =>
  w.brain.executeCommand(actor, command(w, "session.delegate", key, payload), `corr-${key}`).then((outcome) => outcome.receipt);

/** A mission whose one task is running as a session of an agent that may delegate. */
async function parentSession(options: Parameters<typeof startedMission>[0] = {}) {
  const world = await startedMission({ starter: delegatingStarter(), ...options });
  const offer = running(world.w, world.runner, "parent");
  return { ...world, offer, ...(await sessionActor(world.w, world.runner, offer)) };
}

describe("a delegated child session is a run of the mission, not of its parent's task", () => {
  it("runs as its own job under the mission, as the member's principal, without moving the parent's task", async () => {
    const { w, missionId, workItemId, runner, actor, sessionId } = await parentSession();
    const receipt = await delegate(w, actor, "d1", { missionId, task: "Compare the two vendors' prices" });
    expect(receipt.accepted).toBe(true);
    const delegation = await delegationOf(w, receipt.resourceId!);
    expect(delegation).toMatchObject({ parentSessionId: sessionId, workItemId, depth: 1, state: "active", memberId: "pi", task: "Compare the two vendors' prices", delegatedBy: actor.actorId, run: { state: "running" } });

    // The child's job went through the normal job creation: one queued job of its own run, which the mission is charged for.
    const jobs = jobsOf(w, delegation.run.runId!);
    expect(jobs).toEqual([expect.objectContaining({ step: "respond", state: "queued" })]);
    const child = await sessionOf(w, delegation.childSessionId);
    expect(child).toMatchObject({ parentSessionId: sessionId, rootSessionId: sessionId, delegationDepth: 1, state: "starting" });

    // A runner claims it like any job; the child's attempt binds the child session and acts as the same member, on no task of its own.
    const offer = running(w, runner, "child");
    expect(offer.jobId).toBe(jobs[0]!.id);
    expect(await sessionOf(w, delegation.childSessionId)).toMatchObject({ state: "running", attemptId: offer.attemptId, agentId: "task-worker" });
    expect(w.brain.jobProtocol.sessionCredential(runner, offer.attemptId).principalId).toBe(actor.actorId);
    const mission = await missionOf(w, missionId);
    expect(mission.usage.runningMembers).toBe(2);

    // The parent's task is exactly as it was: still its own run, not moved, no failed attempt, no second run linked.
    const item = await taskItem(w, workItemId);
    expect(item).toMatchObject({ state: "in-progress", failedAttempts: 0, parked: false });
    expect((await query<{ items: Array<{ runId: string }> }>(w, "executionLinks.list")).items).toHaveLength(1);
  });

  it("returns the child's result to the parent as a handoff of its own, and the parent task's handoff is untouched", async () => {
    const { w, missionId, workItemId, offer: parentOffer, actor, sessionId } = await parentSession();
    // The parent writes its own handoff first; the child's result must never replace it.
    expect((await w.brain.executeCommand(actor, command(w, "handoff.submit", "own-handoff", { workItemId, notes: { summary: "My own notes" } }), "c")).receipt.accepted).toBe(true);
    const id = (await delegate(w, actor, "d2", { missionId, task: "Summarise the source table" })).resourceId!;
    const { runId } = (await delegationOf(w, id)).run;
    w.brain.workflows.completeStep(w.org, w.workspaceId, runId!, "respond", { summary: "The table lists 12 vendors.", deliverable: "# Vendors\n\nTwelve vendors, three of them in the EU.", criteria: [], assumptions: [] }, true);
    w.brain.workflows.completeStep(w.org, w.workspaceId, runId!, "validate", { passed: true }, true);

    const done = await delegationOf(w, id);
    expect(done.run).toMatchObject({ state: "succeeded", result: expect.stringContaining("The table lists 12 vendors.") });
    expect(done.run.handoffId).toBeTruthy();
    // The parent's own session reads it from its context, as a claim from the child, next to the delegation's state.
    const context = await query<SessionContext>(w, "sessions.context", sessionId);
    expect(context.delegatedHandoffs).toEqual([expect.objectContaining({ handoffId: done.run.handoffId, delegationId: id, workItemId, notes: expect.objectContaining({ summary: expect.stringContaining("Twelve vendors") }) })]);
    expect(context.delegations?.map((entry) => entry.run.state)).toEqual(["succeeded"]);
    // The task's own handoff is still the current one, and nothing downstream reads the child's.
    const own = (await query<{ items: unknown[] }>(w, "handoffs.forWorkItem", workItemId)).items;
    expect(own).toEqual([]);
    expect(w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT submitted_by, delegation_id FROM handoffs WHERE work_item_id=? AND superseded_by IS NULL ORDER BY version").all(workItemId))
      .toEqual([{ submitted_by: actor.actorId, delegation_id: null }, { submitted_by: actor.actorId, delegation_id: id }]);
    // The child finishing did not make the parent's task done or move it to review.
    expect(await taskItem(w, workItemId)).toMatchObject({ state: "in-progress", failedAttempts: 0 });
    void parentOffer;
  });

  it("tells the parent a child failed, as a failure fact on the delegation, and counts no failed attempt against the task", async () => {
    const { w, missionId, workItemId, runner, actor, sessionId } = await parentSession();
    const id = (await delegate(w, actor, "d3", { missionId, task: "Look up the supplier register" })).resourceId!;
    const { runId } = (await delegationOf(w, id)).run;
    // The child's attempt runs and fails, as a model's can: the runner reports it through the protocol, nothing is written by hand.
    const childOffer = running(w, runner, "child-fails");
    w.brain.jobProtocol.complete(runner, childOffer.attemptId, { result: "failed", jobFence: childOffer.jobFence, cleanupConfirmed: true, output: { error: "the register could not be reached" } });

    const failed = await delegationOf(w, id);
    expect(failed.run).toMatchObject({ state: "failed", failure: expect.stringContaining("the register could not be reached") });
    expect(failed.run.handoffId).toBeUndefined();
    expect(failed.review).toMatchObject({ possible: false, reason: expect.stringMatching(/failed/u) });
    expect(await sessionOf(w, failed.childSessionId)).toMatchObject({ state: "failed" });
    // The parent reads the failure in its context; the task is neither failed nor parked by it.
    const context = await query<SessionContext>(w, "sessions.context", sessionId);
    expect(context.delegations?.[0]?.run).toMatchObject({ state: "failed" });
    expect(context.delegatedHandoffs ?? []).toEqual([]);
    expect(await taskItem(w, workItemId)).toMatchObject({ state: "in-progress", failedAttempts: 0, parked: false });
    // A failed child needs no person: its job is failed, and still never asks for intervention.
    const job = (await query<{ items: Array<{ jobId: string; state: string; needsYou?: boolean }> }>(w, "jobs.list")).items.find((entry) => entry.jobId === childOffer.jobId)!;
    expect(job).toMatchObject({ state: "failed", needsYou: false });
    void runId;
  });

  it("steers a live parent that takes steering the moment its child ends", async () => {
    const { w, missionId, runner } = await startedMission({ starter: delegatingStarter() });
    const offer = w.brain.jobProtocol.claim(runner, "claim-steer") as unknown as Offer;
    w.brain.jobProtocol.ack(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence, engine: { id: "fixture", adapterDigest: DIGEST_A, features: ["sessions", "steer"] } });
    const { actor } = await sessionActor(w, runner, offer);
    const id = (await delegate(w, actor, "d-steer", { missionId, task: "Check the totals" })).resourceId!;
    const { runId } = (await delegationOf(w, id)).run;
    w.brain.workflows.completeStep(w.org, w.workspaceId, runId!, "respond", { error: "the totals sheet is empty" }, false);
    const controls = db(w).prepare("SELECT kind, payload FROM session_controls").all() as Array<{ kind: string; payload: string }>;
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({ kind: "session.steer" });
    expect((JSON.parse(controls[0]!.payload) as { message: string }).message).toMatch(/Delegated work failed.*the totals sheet is empty/u);
  });
});

describe("depth, children and who may delegate", () => {
  it("refuses a delegation deeper than three levels with the reason, after three chained delegations", async () => {
    const { w, missionId, sessionId } = await parentSession();
    // A person starts the chain from the running session; each child (still waiting for a runner) is itself an active parent.
    const chain: string[] = [sessionId];
    for (const level of [1, 2, 3]) {
      const receipt = await run(w, "session.delegate", `chain-${level}`, { parentSessionId: chain.at(-1)!, task: `Level ${level} sub-task` });
      chain.push((await delegationOf(w, receipt.resourceId!)).childSessionId);
      expect((await sessionOf(w, chain.at(-1)!)).delegationDepth).toBe(level);
    }
    await expect(run(w, "session.delegate", "chain-4", { parentSessionId: chain.at(-1)!, task: "Level 4 sub-task" })).rejects.toThrow(/Maximum delegation depth is 3.*do this sub-task itself/su);
    expect(await delegations(w)).toHaveLength(3);
    void missionId;
  });

  it("holds an agent to what its definition declares: none without children, a bounded number with them, at most its depth", async () => {
    // The shipped starter gives its task worker no children: its session cannot delegate, whatever tool it is offered.
    const none = await parentSession({ starter: fixtureStarter() });
    await expect(delegate(none.w, none.actor, "d-none", { missionId: none.missionId, task: "Anything" })).rejects.toThrow(/Agent task-worker is not set up to delegate/u);
    expect(await delegations(none.w)).toEqual([]);
    closeWorlds();

    const two = await parentSession({ starter: delegatingStarter({ maxChildren: 2, maxDepth: 1 }) });
    const first = await delegate(two.w, two.actor, "d-a", { missionId: two.missionId, task: "First part" });
    expect(first.accepted).toBe(true);
    await delegate(two.w, two.actor, "d-b", { missionId: two.missionId, task: "Second part" });
    await expect(delegate(two.w, two.actor, "d-c", { missionId: two.missionId, task: "Third part" })).rejects.toThrow(/already has 2 child sessions working/u);
    // maxDepth 1: a child of a child is deeper than the agent allows, though three levels would be the platform's limit.
    const child = (await delegationOf(two.w, first.resourceId!)).childSessionId;
    await expect(run(two.w, "session.delegate", "too-deep", { parentSessionId: child, task: "Deeper" })).rejects.toThrow(/Agent task-worker is not set up to delegate this far/u);
  });

  it("lets a session delegate only from itself and only inside its own mission", async () => {
    const { w, missionId, sessionId, actor } = await parentSession();
    const other = (await run(w, "mission.create", "other-create", { title: "Another", intent: "Not this one", successCriteria: ["x"] })).resourceId ?? "";
    const otherPlan = (await run(w, "plan.propose", "other-plan", { missionId: other, origin: "manual", tasks: [{ id: "z", title: "Task z", criteria: ["z is done"], dependsOn: [] }] })).resourceId ?? "";
    await run(w, "plan.confirm", "other-confirm", { planVersionId: otherPlan }, (await missionOf(w, other)).version);
    const child = (await delegationOf(w, (await delegate(w, actor, "d-own", { missionId, task: "Mine" })).resourceId!)).childSessionId;
    // Naming another of the mission's sessions as the parent is refused: a session speaks only for itself.
    await expect(delegate(w, actor, "d-forge", { missionId, parentSessionId: child, task: "As my child" })).rejects.toThrow(/only from itself/u);
    // Naming a mission that is not its own is refused before anything is read.
    await expect(delegate(w, actor, "d-elsewhere", { missionId: other, task: "Wandering" })).rejects.toThrow(/its own mission/u);
    expect(await delegations(w)).toHaveLength(1);
    void sessionId;
  });

  it("names a team member of the mission for the child, and refuses one the mission does not have", async () => {
    const { w, missionId, actor } = await parentSession();
    await expect(delegate(w, actor, "d-nobody", { missionId, task: "Hand it on", memberId: "nobody" })).rejects.toThrow(/not a member of this mission's team/u);
    const id = (await delegate(w, actor, "d-self", { missionId, task: "Do it", memberId: "pi" })).resourceId!;
    expect((await delegationOf(w, id)).memberId).toBe("pi");
  });
});

describe("the child counts toward the mission's member cap and budget", () => {
  it("waits for a free member when the cap is reached, then is admitted when its parent's attempt ends", async () => {
    const { w, missionId, runner, offer: parentOffer, actor } = await parentSession({ budget: { maxMicroUsd: 1_000_000, memberCap: 1, attemptReserveMicroUsd: 10 } });
    const id = (await delegate(w, actor, "d-cap", { missionId, task: "A part of it" })).resourceId!;
    const { runId } = (await delegationOf(w, id)).run;
    expect(w.brain.jobProtocol.claim(runner, "claim-capped")).toBeNull();
    expect(jobsOf(w, runId!)).toEqual([expect.objectContaining({ state: "queued", reason: "waiting: member cap" })]);
    w.brain.jobProtocol.releaseReservation(parentOffer.attemptId);
    const claimed = w.brain.jobProtocol.claim(runner, "claim-freed") as unknown as Offer;
    expect(claimed.jobId).toBe(jobsOf(w, runId!)[0]!.id);
  });

  it("spends the mission's budget: with no headroom left for another attempt the child waits for budget", async () => {
    const { w, missionId, runner, actor } = await parentSession({ budget: { maxMicroUsd: 100, memberCap: 3, attemptReserveMicroUsd: 60 } });
    const id = (await delegate(w, actor, "d-budget", { missionId, task: "A costly part" })).resourceId!;
    const { runId } = (await delegationOf(w, id)).run;
    expect(w.brain.jobProtocol.claim(runner, "claim-budget")).toBeNull();
    expect(jobsOf(w, runId!)).toEqual([expect.objectContaining({ state: "queued", reason: "waiting: budget" })]);
    expect((await missionOf(w, missionId)).usage.reservedMicroUsd).toBe(60);
  });

  it("bounds what a parent can hand out: children share the parent's unreserved session budget", async () => {
    const { w, missionId, actor } = await parentSession();
    const half = (await delegationOf(w, (await delegate(w, actor, "d-half", { missionId, task: "First" })).resourceId!)).budget;
    // The task worker declares 100000 tokens and 8 turns; a child takes half of what is left unless it asks for less.
    expect(half).toEqual({ maxTokens: 50_000, maxMicroUsd: 0, maxTurns: 4 });
    await expect(delegate(w, actor, "d-greedy", { missionId, task: "Second", budget: { maxTokens: 60_000, maxMicroUsd: 0, maxTurns: 2 } })).rejects.toThrow(/exceeds the parent's unreserved budget/u);
  });
});

describe("a delegated child starts after a restart too", () => {
  it("is started by the maintenance pass when the governor was draining at the command", async () => {
    const { w, missionId, actor } = await parentSession();
    await run(w, "platform.drain.set", "drain-on", { draining: true });
    const id = (await delegate(w, actor, "d-drain", { missionId, task: "Wait for the deploy" })).resourceId!;
    expect((await delegationOf(w, id)).run).toMatchObject({ state: "pending" });
    expect((await sessionOf(w, (await delegationOf(w, id)).childSessionId)).state).toBe("waiting");
    await run(w, "platform.drain.set", "drain-off", { draining: false });
    expect(w.brain.delegationRuns.sweep(w.org, w.workspaceId)).toBe(1);
    const started = await delegationOf(w, id);
    expect(started.run).toMatchObject({ state: "running" });
    expect(jobsOf(w, started.run.runId!)).toHaveLength(1);
    // A second pass starts nothing again: the run belongs to the delegation.
    expect(w.brain.delegationRuns.sweep(w.org, w.workspaceId)).toBe(0);
  });

  it("settles a child whose run ended while nobody listened, from the run's own state", async () => {
    const { w, missionId, actor } = await parentSession();
    const id = (await delegate(w, actor, "d-cancel", { missionId, task: "Cancelled by a person" })).resourceId!;
    const { runId } = (await delegationOf(w, id)).run;
    await run(w, "workflow.cancel", "cancel-child", { runId: runId!, reason: "Cancelled by a person" });
    w.brain.delegationRuns.sweep(w.org, w.workspaceId);
    expect((await delegationOf(w, id)).run).toMatchObject({ state: "failed", failure: expect.stringMatching(/cancelled/u) });
  });
});
