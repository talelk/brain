import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, BrainSession, Delegation } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { setupWorld } from "../helpers";
import { delegatingStarter } from "../support/starter";
import { delegateFrom, delegationsOf, driveChildren, enrollChildRunners, registerRunner, sessionIdentity, startAttempt } from "../support/delegation-world";
import { stageStarter } from "../support/machine-session";

// A delegated child run end to end on the fixture engine, with the real evidence and independent check it produces, and the review a person
// decides on it (ADR 0053). The independence rules are the Governor's: a team member never reviews, nor the person who started the delegation.

const tmp = process.env["TMPDIR"] ?? "/tmp";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function boot() {
  const root = mkdtempSync(join(tmp, "brain-delegation-review-"));
  const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
  cleanups.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const w = setupWorld(app.brain);
  stageStarter(w, delegatingStarter({ maxChildren: 3, maxDepth: 3 }));
  const command = async (actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) =>
    (await app.brain.executeCommand(actor, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key)).receipt;
  const missionId = (await command(w.owner, "mission.create", "m", { title: "Choose a supplier", intent: "Pick one", successCriteria: ["chosen"] })).resourceId!;
  const planId = (await command(w.owner, "plan.propose", "p", { missionId, origin: "manual", tasks: [{ id: "compare", title: "Compare vendor prices", criteria: ["compared"], dependsOn: [], assignment: { kind: "agent", id: "pi", role: "specialist" } }] })).resourceId!;
  await command(w.owner, "plan.confirm", "c", { planVersionId: planId }, 1);
  const manual = registerRunner(app.brain, w.owner, "runner-parent");
  const attempt = startAttempt(app.brain, manual, "parent");
  const agent = await sessionIdentity(app.brain, manual, attempt, w.workspaceId);
  const parent = ((await app.brain.executeQuery(w.owner, { queryType: "sessions.list", workspaceId: w.workspaceId } as never)) as unknown as { snapshot: { items: BrainSession[] } }).snapshot.items.find((entry) => entry.attemptId === attempt.attemptId)!;
  const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
  const runners = await enrollChildRunners(app.brain, w.owner, "http://127.0.0.1:3000", "child", transport);
  const list = () => delegationsOf(app.brain, w.owner, w.workspaceId, missionId);
  const finished = (n: number) => () => (app.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT COUNT(*) AS n FROM delegation_runs WHERE state IN ('succeeded','failed')").get() as { n: number }).n >= n;
  return { app, w, command, missionId, agent, parent, runners, list, finished };
}

describe("a delegated child's result is reviewed on its own evidence", () => {
  it("runs on the fixture engine, returns a verified result and is accepted by an independent person only", async () => {
    const { app, w, command, missionId, agent, parent, runners, list, finished } = await boot();
    const id = (await delegateFrom(app.brain, agent, w.workspaceId, "d1", { missionId, task: "Summarise the three cheapest vendors" })).resourceId!;
    await driveChildren(app.brain, runners, finished(1));
    const done = (await list()).find((entry) => entry.delegationId === id)!;
    expect(done.run).toMatchObject({ state: "succeeded", result: expect.stringContaining("Fixture result for: Summarise the three cheapest vendors") });
    expect(done.evidence).toMatchObject({ bundleState: "verified", verdict: "verified" });
    expect(done.agentId).toBe("task-worker");

    // A team member never reviews, whatever it names; the person who started the delegation cannot either.
    await expect(command(agent, "delegation.review", "agent-review", { delegationId: id, decision: "accepted", evidenceDigest: done.evidence!.digest })).rejects.toThrow(/actor kind agent cannot run|cannot run/u);
    expect(done.review).toMatchObject({ possible: true });
    const reviewer = (await w.grantApprover("reviewer-1")).actor;
    const asReviewer = (await delegationsOf(app.brain, reviewer, w.workspaceId, missionId)).find((entry) => entry.delegationId === id)!;
    expect(asReviewer.review).toEqual({ possible: true });
    const decided = await command(reviewer, "delegation.review", "accept", { delegationId: id, decision: "accepted", evidenceDigest: done.evidence!.digest });
    expect(decided.accepted).toBe(true);
    expect(await list()).toEqual(expect.arrayContaining([expect.objectContaining({ delegationId: id, state: "accepted", reviewerId: "reviewer-1" })]));
    // Final: a decided review is not decided twice, and the parent session is untouched.
    await expect(command(reviewer, "delegation.review", "again", { delegationId: id, decision: "rejected", evidenceDigest: done.evidence!.digest })).rejects.toThrow(/already final/u);
    expect((await app.brain.executeQuery(w.owner, { queryType: "session.get", workspaceId: w.workspaceId, resourceId: parent.sessionId } as never) as unknown as { snapshot: BrainSession }).snapshot.state).toBe("running");
  }, 120_000);

  it("never lets the person who started a delegation review it, and a person may reject", async () => {
    const { app, w, command, parent, runners, list, finished, missionId } = await boot();
    const id = (await command(w.owner, "session.delegate", "mine", { parentSessionId: parent.sessionId, task: "Draft the shortlist" })).resourceId!;
    await driveChildren(app.brain, runners, finished(1));
    const mine = (await list()).find((entry) => entry.delegationId === id) as Delegation;
    expect(mine.review).toMatchObject({ possible: false, reason: expect.stringMatching(/You started this delegation/u) });
    await expect(command(w.owner, "delegation.review", "own", { delegationId: id, decision: "accepted", evidenceDigest: mine.evidence!.digest })).rejects.toThrow(/independent reviewer/u);
    const reviewer = (await w.grantApprover("reviewer-2")).actor;
    expect((await command(reviewer, "delegation.review", "reject", { delegationId: id, decision: "rejected", evidenceDigest: mine.evidence!.digest })).accepted).toBe(true);
    const after = (await list()).find((entry) => entry.delegationId === id)!;
    expect(after).toMatchObject({ state: "rejected", reviewerId: "reviewer-2" });
    expect((await app.brain.executeQuery(w.owner, { queryType: "session.get", workspaceId: w.workspaceId, resourceId: after.childSessionId } as never) as unknown as { snapshot: BrainSession }).snapshot.state).toBe("failed");
    void missionId;
  }, 120_000);
});
