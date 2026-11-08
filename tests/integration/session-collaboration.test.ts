import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, SessionContext, SessionDetail } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { setupWorld, type TestWorld, workView } from "../helpers";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function run(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>, actor: ActorContext = w.owner, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload,
  } as never, key)).receipt;
}

async function workItem(w: TestWorld, key: string): Promise<string> {
  const missionId = (await run(w, "mission.create", `${key}-objective`, { title: "Collaborative work", intent: "Complete independent implementation and review", successCriteria: ["Verified result"] })).resourceId!;
  const planId = (await run(w, "plan.propose", `${key}-plan`, { missionId, origin: "manual", tasks: [{ id: "task", title: "Implement", criteria: ["verified"], dependsOn: [], workflowId: "fixture-workflow" }] })).resourceId!;
  await run(w, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, w.owner, 1);
  const board = (await workView(w));
  return board.items.find((item) => item.missionId === missionId)!.workItemId;
}

function sessionInput(workItemId: string, task = "Inspect the workspace"): Record<string, unknown> {
  return {
    workItemId, agentId: "parent-agent", engineId: "pi", task,
    budget: { maxTokens: 1000, maxMicroUsd: 500, maxTurns: 4 },
    scope: { allowedPaths: ["src", "tests"], prohibitedPaths: ["secrets"], allowedTools: ["fixture.echo"] },
    worktreeId: "wt-parent",
  };
}

async function session(w: TestWorld, id: string): Promise<SessionDetail> {
  return ((await w.brain.executeQuery(w.owner, { queryType: "session.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: SessionDetail }).snapshot;
}

describe("native and managed BrainSessions (T53)", () => {
  it("resumes a checkpoint as a new managed session; messages reach the next session and its context (T53, E118)", async () => {
    const w = setupWorld();
    cleanup.push(() => w.brain.close());
    const item = await workItem(w, "resume");
    const input = sessionInput(item);
    const parentId = (await run(w, "session.create", "session-create", input)).resourceId!;
    expect(await session(w, parentId)).toEqual(expect.objectContaining({ mode: "managed", state: "waiting", rootSessionId: parentId }));
    expect((await session(w, parentId)).jobId).toBeUndefined();
    expect(validate("SessionDetail", await session(w, parentId))).toEqual({ ok: true, errors: [] });
    const checkpoint = {
      contractVersion: "brain.checkpoint/v2", sourceRevision: "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4",
      diffDigest: `sha256:${"b".repeat(64)}`, completedCriteria: ["inspect"], failures: ["verification pending"],
      worktreeId: "wt-parent", eventSequence: 0, nextAction: "Run the independent verification", createdAt: w.brain.store.nowIso(),
    };
    await run(w, "session.checkpoint", "session-checkpoint", { sessionId: parentId, checkpoint }, w.owner, 1);
    const missionId = (await workView(w)).items.find((entry) => entry.workItemId === item)!.missionId;
    const first = (await run(w, "mission.message.send", "message-1", { missionId, recipient: { kind: "mission" }, workItemId: item, body: "Verification is next." })).resourceId!;
    await run(w, "mission.message.send", "message-2", { missionId, recipient: { kind: "mission" }, workItemId: item, body: "Correction: independent verification is next.", correctionOf: first });
    const resumedId = (await run(w, "session.create", "session-resume", { ...input, task: checkpoint.nextAction, engineId: "claude", resumeFromSessionId: parentId })).resourceId!;
    const resumed = await session(w, resumedId);
    expect(resumed).toEqual(expect.objectContaining({
      mode: "managed", state: "waiting", parentSessionId: parentId, rootSessionId: parentId,
      task: checkpoint.nextAction, workItemId: item, worktreeId: "wt-parent",
      engine: expect.objectContaining({ id: "claude", version: "unbound" }),
      checkpoint: expect.objectContaining({ nextAction: checkpoint.nextAction, diffDigest: checkpoint.diffDigest, briefVersion: 1 }),
    }));
    expect(resumed.sessionId).not.toBe(parentId);

    const context = ((await w.brain.executeQuery(w.owner, { queryType: "sessions.context", workspaceId: w.workspaceId, resourceId: resumedId })) as { snapshot: SessionContext }).snapshot;
    expect(validate("SessionContext", context)).toEqual({ ok: true, errors: [] });
    expect(context.brief).toEqual(expect.objectContaining({ missionId, version: 1 }));
    expect(context.messages.map((entry) => [entry.body, entry.delivery])).toEqual([["Correction: independent verification is next.", "delivered-at-session-start"]]);
    expect(context.checkpoint).toEqual(expect.objectContaining({ nextAction: checkpoint.nextAction }));
    await expect(Promise.resolve().then(async () => await run(w, "session.create", "resume-expanded", { ...input, task: checkpoint.nextAction, resumeFromSessionId: parentId, scope: { allowedPaths: ["src", "tests", "secrets"], prohibitedPaths: [], allowedTools: ["fixture.echo"] } }))).rejects.toThrow(/cannot expand|checkpoint authority/i);
  });

  it("binds a managed session to its real dispatched attempt and WorkItem execution link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-session-collaboration-"));
    const app = await createApp({ dataDir: join(dir, "data"), allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const item = await workItem(w, "dispatch");
    const sessionId = (await run(w, "session.create", "dispatch-session", sessionInput(item, "Execute the fixture task"))).resourceId!;
    const runId = (await run(w, "workflow.dispatch", "dispatch-managed", {
      workflow: { id: "fixture-workflow", digest: w.brain.activeRelease(w.org)!.digest }, input: { message: "Brain fixture" }, sessionId,
    })).resourceId!;
    const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
    const config = { governorUrl: "http://127.0.0.1:3000", runnerId: "session-runner", stateDir: join(dir, "runner"), transport, engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
    const enrolled = await enrollAndHello(config, w.brain.jobProtocol.issueEnrollment(w.owner, "fixture-tools").token);
    expect(await runOnce(config, enrolled.sessionToken, enrolled.epoch)).toBe(true);
    const bound = await session(w, sessionId);
    expect(bound).toEqual(expect.objectContaining({ sessionId, mode: "managed", state: "stopped", engine: expect.objectContaining({ id: "tool-broker" }) }));
    expect(bound.jobId).toBeTruthy();
    expect(bound.attemptId).toBeTruthy();
    const board = (await workView(w));
    expect(board.executions).toEqual(expect.arrayContaining([expect.objectContaining({ workItemId: item, runId, sessionId, jobId: bound.jobId })]));
  });
});
