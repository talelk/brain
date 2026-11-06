import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Workflow } from "@brain/contracts";
import { MastraWorkflowEngine } from "../../apps/governor/src/modules/workflows/index";
import { drainSessionControls, recordAttemptSession } from "../../apps/governor/src/modules/sessions/index";
import { setupWorld, DIGEST_A, type TestWorld } from "../helpers";

// The sessions module owns the control queue: controls are keyed by session
// id, and the runner holding the session's attempt receives them. A workflow
// steer step resolves its sessionFrom/messageFrom bindings and fails when it
// cannot reach a session.

function steerFlow(sessionFrom: unknown): Workflow {
  return {
    apiVersion: "brain.keyrus/v1", kind: "Workflow",
    metadata: { id: "steer-flow", version: "1.0.0" },
    spec: {
      inputSchemaRef: "s", outputSchemaRef: "s", outputs: {}, failFast: true, deadlineSeconds: 60,
      jobs: {
        nudge: {
          kind: "steer", needs: [], input: {}, outputSchemaRef: "s",
          sessionFrom, messageFrom: { source: "literal", value: "Report your checkpoint." },
        },
      },
    },
  } as unknown as Workflow;
}

function boundSession(w: TestWorld, attemptId: string): string {
  recordAttemptSession(w.brain.store, { organizationId: w.org, workspaceId: w.workspaceId, jobId: "job-steer", attemptId, engineId: "fixture", adapterDigest: DIGEST_A });
  return "ses-job-steer";
}

async function runToEnd(w: TestWorld, engine: MastraWorkflowEngine, runInput: Record<string, string>, key: string): Promise<{ runState: string; stepState: string }> {
  const { runId } = engine.startRun({
    organizationId: w.org, workspaceId: w.workspaceId, actorId: "owner-1", workflowId: "steer-flow",
    workflow: steerFlow({ source: "input", pointer: "/sessionId" }), configDigest: DIGEST_A, runInput, executionKey: key,
  });
  const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
  const deadline = Date.now() + 30_000;
  let run = { state: "" };
  while (Date.now() < deadline) {
    await engine.settle();
    run = ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string };
    if (["succeeded", "failed"].includes(run.state)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const step = ws.prepare("SELECT state FROM workflow_steps WHERE run_id=? AND step_id='nudge'").get(runId) as { state: string };
  return { runState: run.state, stepState: step.state };
}

describe("session control queue (sessions module)", () => {
  it("a workflow steer step queues its message for the bound session, and the runner holding the attempt receives it", async () => {
    const w = setupWorld();
    const sessionId = boundSession(w, "att-steer");
    const engine = new MastraWorkflowEngine(w.brain.store, w.brain, join(w.dir, "mastra-steer"));
    expect(await runToEnd(w, engine, { sessionId }, "steer-ok")).toEqual({ runState: "succeeded", stepState: "succeeded" });

    const live = [{ attemptId: "att-steer", workspaceId: w.workspaceId, organizationId: w.org }];
    const delivered = drainSessionControls(w.brain.store, live, 100);
    expect(delivered).toEqual([expect.objectContaining({ type: "steer", attemptId: "att-steer", text: "Report your checkpoint." })]);
    expect(drainSessionControls(w.brain.store, live, 100)).toEqual([]);
  });

  it("a steer step aimed at a session absent from the workspace fails the step and the run, queuing nothing", async () => {
    const w = setupWorld();
    const engine = new MastraWorkflowEngine(w.brain.store, w.brain, join(w.dir, "mastra-steer-missing"));
    expect(await runToEnd(w, engine, { sessionId: "ses-nowhere" }, "steer-missing")).toEqual({ runState: "failed", stepState: "failed" });
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    expect((ws.prepare("SELECT COUNT(*) AS n FROM session_controls").get() as { n: number }).n).toBe(0);
  });

  it("session.steer and session.stop commands drain to the attempt in order", async () => {
    const w = setupWorld();
    const sessionId = boundSession(w, "att-cmd");
    for (const [i, commandType] of (["session.steer", "session.stop"] as const).entries()) {
      await w.brain.executeCommand(w.owner, {
        contractVersion: "brain.command/v1", commandId: `cmd-ctl-${i}`, commandType, workspaceId: w.workspaceId, idempotencyKey: `ctl-${i}`,
        payload: commandType === "session.steer" ? { sessionId, message: "narrow the scope" } : { sessionId, reason: "operator stop" },
      }, `ctl-${i}`);
    }
    const delivered = drainSessionControls(w.brain.store, [{ attemptId: "att-cmd", workspaceId: w.workspaceId, organizationId: w.org }], 100);
    expect(delivered.map((d) => [d.type, d.text])).toEqual([["steer", "narrow the scope"], ["stop-attempt", undefined]]);
  });

  it("an ended session refuses steer and stop instead of queuing controls nobody drains", async () => {
    const w = setupWorld();
    const sessionId = boundSession(w, "att-ended");
    const ws = w.brain.store.workspaceDb(w.workspaceId, w.org);
    for (const state of ["stopped", "failed"]) {
      ws.prepare("UPDATE sessions SET state=? WHERE id=?").run(state, sessionId);
      await expect(w.brain.executeCommand(w.owner, {
        contractVersion: "brain.command/v1", commandId: `cmd-ended-${state}`, commandType: "session.steer", workspaceId: w.workspaceId, idempotencyKey: `ended-${state}`,
        payload: { sessionId, message: "too late" },
      }, `ended-${state}`)).rejects.toThrow(/has ended/);
    }
    expect((ws.prepare("SELECT COUNT(*) AS n FROM session_controls").get() as { n: number }).n).toBe(0);

    const engine = new MastraWorkflowEngine(w.brain.store, w.brain, join(w.dir, "mastra-steer-ended"));
    expect(await runToEnd(w, engine, { sessionId }, "steer-ended")).toEqual({ runState: "failed", stepState: "failed" });
  });
});
