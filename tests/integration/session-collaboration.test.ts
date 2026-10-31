import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, BrainSession, CommandReceipt, WorkBoardView, WorkItemMessage } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { setupWorld, type TestWorld } from "../helpers";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function run(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>, actor: ActorContext = w.owner, expectedVersion?: number): CommandReceipt {
  return w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload,
  } as never, key).receipt;
}

function workItem(w: TestWorld, key: string): string {
  const objectiveId = run(w, "objective.create", `${key}-objective`, { title: "Collaborative work", intent: "Complete independent implementation and review", successCriteria: ["Verified result"] }).resourceId!;
  const planId = run(w, "plan.propose", `${key}-plan`, { objectiveId, origin: "manual", tasks: [{ id: "task", title: "Implement", criteria: ["verified"], dependsOn: [], workflowId: "fixture-workflow" }] }).resourceId!;
  run(w, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, w.owner, 1);
  const board = (w.brain.executeQuery(w.owner, { queryType: "workBoard.get", workspaceId: w.workspaceId }) as { snapshot: WorkBoardView }).snapshot;
  return board.items.find((item) => item.objectiveId === objectiveId)!.workItemId;
}

function sessionInput(workItemId: string, task = "Inspect the workspace"): Record<string, unknown> {
  return {
    workItemId, agentId: "parent-agent", engineId: "pi", task,
    budget: { maxTokens: 1000, maxMicroUsd: 500, maxTurns: 4 },
    scope: { allowedPaths: ["src", "tests"], prohibitedPaths: ["secrets"], allowedTools: ["fixture.echo"] },
    worktreeId: "wt-parent",
  };
}

function session(w: TestWorld, id: string): BrainSession {
  return (w.brain.executeQuery(w.owner, { queryType: "session.get", workspaceId: w.workspaceId, resourceId: id }) as { snapshot: BrainSession }).snapshot;
}

describe("native and managed BrainSessions (T53)", () => {
  it("resumes a portable checkpoint as a new managed session and preserves WorkItem message lineage", () => {
    const w = setupWorld();
    cleanup.push(() => w.brain.close());
    const item = workItem(w, "resume");
    const input = sessionInput(item);
    const parentId = run(w, "session.create", "session-create", input).resourceId!;
    expect(session(w, parentId)).toEqual(expect.objectContaining({ mode: "managed", state: "waiting", rootSessionId: parentId }));
    expect(session(w, parentId).jobId).toBeUndefined();
    expect(validate("BrainSession", session(w, parentId))).toEqual({ ok: true, errors: [] });
    const checkpoint = {
      sourceRevision: "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4",
      dirtyDiffDigest: `sha256:${"b".repeat(64)}`, completedCriteria: ["inspect"], outstandingFailures: ["verification pending"],
      worktreeId: "wt-parent", eventCursor: 0, nextAction: "Run the independent verification", createdAt: w.brain.store.nowIso(),
    };
    run(w, "session.checkpoint", "session-checkpoint", { sessionId: parentId, checkpoint }, w.owner, 1);
    const resumedId = run(w, "session.create", "session-resume", { ...input, task: checkpoint.nextAction, engineId: "claude", resumeFromSessionId: parentId }).resourceId!;
    const resumed = session(w, resumedId);
    expect(resumed).toEqual(expect.objectContaining({
      mode: "managed", state: "waiting", parentSessionId: parentId, rootSessionId: parentId,
      task: checkpoint.nextAction, workItemId: item, worktreeId: "wt-parent",
      engine: expect.objectContaining({ id: "claude", version: "unbound" }),
      checkpoint: expect.objectContaining({ nextAction: checkpoint.nextAction, dirtyDiffDigest: checkpoint.dirtyDiffDigest }),
    }));
    expect(resumed.sessionId).not.toBe(parentId);

    const messageId = run(w, "workItem.message", "message-1", { workItemId: item, sessionId: resumedId, body: "Checkpoint restored; verification is next." }).resourceId!;
    run(w, "workItem.message", "message-2", { workItemId: item, sessionId: resumedId, body: "Correction: independent verification is next.", correctionOf: messageId });
    const messages = (w.brain.executeQuery(w.owner, { queryType: "workItemMessages.list", workspaceId: w.workspaceId, resourceId: item }) as { snapshot: { items: WorkItemMessage[] } }).snapshot.items;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual(expect.objectContaining({ correctionOf: messageId, sessionId: resumedId, workItemId: item }));
    expect(() => run(w, "session.create", "resume-expanded", { ...input, task: checkpoint.nextAction, resumeFromSessionId: parentId, scope: { allowedPaths: ["src", "tests", "secrets"], prohibitedPaths: [], allowedTools: ["fixture.echo"] } })).toThrow(/cannot expand|checkpoint authority/i);
  });

  it("binds a managed session to its real dispatched attempt and WorkItem execution link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-session-collaboration-"));
    const app = await createApp({ dataDir: join(dir, "data"), allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const item = workItem(w, "dispatch");
    const sessionId = run(w, "session.create", "dispatch-session", sessionInput(item, "Execute the fixture task")).resourceId!;
    const runId = run(w, "workflow.dispatch", "dispatch-managed", {
      workflow: { id: "fixture-workflow", digest: w.brain.activeRelease(w.org)!.digest }, input: { message: "Brain fixture" }, sessionId,
    }).resourceId!;
    const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
    const config = { governorUrl: "http://127.0.0.1:3000", runnerId: "session-runner", stateDir: join(dir, "runner"), transport, engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
    const enrolled = await enrollAndHello(config, w.brain.issueEnrollment(w.owner, "fixture-tools").token);
    expect(await runOnce(config, enrolled.sessionToken, enrolled.epoch)).toBe(true);
    const bound = session(w, sessionId);
    expect(bound).toEqual(expect.objectContaining({ sessionId, mode: "managed", state: "stopped", engine: expect.objectContaining({ id: "tool-broker" }) }));
    expect(bound.jobId).toBeTruthy();
    expect(bound.attemptId).toBeTruthy();
    const board = (w.brain.executeQuery(w.owner, { queryType: "workBoard.get", workspaceId: w.workspaceId }) as { snapshot: WorkBoardView }).snapshot;
    expect(board.executions).toEqual(expect.arrayContaining([expect.objectContaining({ workItemId: item, runId, sessionId, jobId: bound.jobId })]));
  });
});
