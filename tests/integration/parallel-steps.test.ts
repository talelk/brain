import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Workflow } from "@brain/contracts";
import type { Brain } from "../../apps/governor/src/application/brain";
import { MastraWorkflowEngine, type WorkflowHost } from "../../apps/governor/src/modules/workflows/index";
import { setupWorld, tempBrain, DIGEST_A } from "../helpers";
import { scaled } from "../support/timing";

// Parallel steps at the engine port (ADR 0043): steps whose needs are met are admitted together, the
// join waits for every branch, a restarted engine takes the remaining completions, and a failed branch stops the run.
function wf(id: string, jobs: Record<string, unknown>): Workflow {
  return {
    apiVersion: "brain.keyrus/v1", kind: "Workflow",
    metadata: { id, version: "1.0.0" },
    spec: { inputSchemaRef: "s", outputSchemaRef: "s", jobs, outputs: {}, failFast: true, deadlineSeconds: 60 },
  } as unknown as Workflow;
}
const readJob = (needs: string[]) => ({ kind: "dispatch", needs, input: {}, effectClass: "read", uses: { type: "tool", release: { id: "fixture.echo", digest: DIGEST_A } }, runsOn: { group: "g", all: [], isolation: "ephemeral-container", resources: { cpuMillicores: 1, memoryMb: 1, diskMb: 1, slots: 1 } } });
const gateJob = (needs: string[]) => ({ kind: "gate", needs, input: {}, proposalFrom: "x", expiresAfterSeconds: 3600 });

interface FakeHost extends WorkflowHost { jobs: string[]; approvals: string[]; failures: string[]; cancelled: string[]; failNextJobFor?: string }
function fakeHost(): FakeHost {
  const host = {
    jobs: [] as string[], approvals: [] as string[], failures: [] as string[], cancelled: [] as string[],
    createJobForStep(input: { stepId: string }) {
      if (host.failNextJobFor === input.stepId) { delete host.failNextJobFor; throw new Error("the Governor stopped while admitting"); }
      host.jobs.push(input.stepId);
      return `job-${input.stepId}-${host.jobs.length}`;
    },
    createApprovalForGate(input: { stepId: string }) { const id = `apr-${input.stepId}`; host.approvals.push(id); return id; },
    runFailed(input: { runId: string }) { host.failures.push(input.runId); },
    runSucceeded() { /* no missions at the engine port */ },
    cancelUnclaimedJobs(runId: string) { host.cancelled.push(runId); },
  };
  return host as unknown as FakeHost;
}

type World = ReturnType<typeof setupWorld>;
const runState = (brain: Brain, w: World, runId: string) => (brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state;
const stepStates = (brain: Brain, w: World, runId: string) => Object.fromEntries((brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT step_id, state FROM workflow_steps WHERE run_id=?").all(runId) as Array<{ step_id: string; state: string }>).map((r) => [r.step_id, r.state]));
const start = (engine: MastraWorkflowEngine, w: World, workflow: Workflow, key: string) => engine.startRun({
  organizationId: w.org, workspaceId: w.workspaceId, actorId: "owner-1", workflowId: workflow.metadata.id, workflow, configDigest: DIGEST_A, runInput: {}, executionKey: key,
}).runId;
const fan = () => wf("fan", { a: readJob([]), b: readJob([]), c: readJob(["a", "b"]) });

describe("parallel workflow steps at the engine port (ADR 0043)", () => {
  it("admits independent steps together, holds the join for both, and takes completions out of order across a restart", async () => {
    const { brain, dir } = tempBrain();
    const w = setupWorld(brain);
    const host = fakeHost();
    const storage = join(dir, "mastra-fan");
    const engine = new MastraWorkflowEngine(brain.store, host, storage);
    const runId = start(engine, w, fan(), "fan-1");
    // Both independent steps have a job before anything completed; the join has none.
    expect([...host.jobs].sort()).toEqual(["a", "b"]);
    await engine.settle();
    engine.completeStep(w.org, w.workspaceId, runId, "b", { b: 1 }, true);
    await engine.settle();
    expect([...host.jobs].sort()).toEqual(["a", "b"]);
    expect(stepStates(brain, w, runId)).toEqual({ a: "running", b: "succeeded", c: "pending" });
    // The Governor restarts with a still running and b's completion on record.
    const restarted = new MastraWorkflowEngine(brain.store, host, storage);
    restarted.completeStep(w.org, w.workspaceId, runId, "a", { a: 1 }, true);
    await restarted.settle();
    expect([...host.jobs].sort()).toEqual(["a", "b", "c"]);
    restarted.completeStep(w.org, w.workspaceId, runId, "c", { c: 1 }, true);
    await restarted.settle();
    expect(runState(brain, w, runId)).toBe("succeeded");
    expect(Object.values(stepStates(brain, w, runId)).every((state) => state === "succeeded")).toBe(true);
    expect([...host.jobs].sort()).toEqual(["a", "b", "c"]);
    brain.close();
  }, scaled(120_000));

  it("completions of two branches arriving together each resume the run once", async () => {
    const { brain, dir } = tempBrain();
    const w = setupWorld(brain);
    const host = fakeHost();
    const engine = new MastraWorkflowEngine(brain.store, host, join(dir, "mastra-together"));
    const runId = start(engine, w, fan(), "together-1");
    await engine.settle();
    engine.completeStep(w.org, w.workspaceId, runId, "a", { a: 1 }, true);
    engine.completeStep(w.org, w.workspaceId, runId, "b", { b: 1 }, true);
    await engine.settle();
    expect(host.jobs.filter((id) => id === "c")).toHaveLength(1);
    engine.completeStep(w.org, w.workspaceId, runId, "c", { c: 1 }, true);
    await engine.settle();
    expect(runState(brain, w, runId)).toBe("succeeded");
    brain.close();
  }, scaled(120_000));

  it("a failed branch fails the run, withdraws unclaimed work and ignores the other branch's late completion", async () => {
    const { brain, dir } = tempBrain();
    const w = setupWorld(brain);
    const host = fakeHost();
    const engine = new MastraWorkflowEngine(brain.store, host, join(dir, "mastra-branch-fail"));
    const runId = start(engine, w, fan(), "branch-fail-1");
    await engine.settle();
    engine.completeStep(w.org, w.workspaceId, runId, "a", { error: "boom" }, false);
    expect(runState(brain, w, runId)).toBe("failed");
    expect(host.failures).toEqual([runId]);
    expect(host.cancelled).toEqual([runId]);
    expect(stepStates(brain, w, runId)).toEqual({ a: "failed", b: "running", c: "skipped" });
    // The branch a runner already held finishes later: nothing moves, nothing is admitted, the failure is reported once.
    engine.completeStep(w.org, w.workspaceId, runId, "b", { b: 1 }, true);
    await engine.settle();
    expect(runState(brain, w, runId)).toBe("failed");
    expect(host.failures).toEqual([runId]);
    expect([...host.jobs].sort()).toEqual(["a", "b"]);
    brain.close();
  }, scaled(120_000));

  it("two gates on parallel branches keep the run suspended until both are decided", async () => {
    const { brain, dir } = tempBrain();
    const w = setupWorld(brain);
    const host = fakeHost();
    const engine = new MastraWorkflowEngine(brain.store, host, join(dir, "mastra-gates"));
    const runId = start(engine, w, wf("two-gates", { g1: gateJob([]), g2: gateJob([]), after: readJob(["g1", "g2"]) }), "two-gates-1");
    await engine.settle();
    expect(host.approvals).toHaveLength(2);
    expect(runState(brain, w, runId)).toBe("suspended");
    engine.wakeGate(w.org, w.workspaceId, host.approvals[0]!, true);
    await engine.settle();
    expect(runState(brain, w, runId)).toBe("suspended");
    expect(host.jobs).toEqual([]);
    engine.wakeGate(w.org, w.workspaceId, host.approvals[1]!, true);
    await engine.settle();
    expect(runState(brain, w, runId)).toBe("running");
    expect(host.jobs).toEqual(["after"]);
    brain.close();
  }, scaled(120_000));

  it("an approval decided after a sibling branch failed the run changes nothing", async () => {
    const { brain, dir } = tempBrain();
    const w = setupWorld(brain);
    const host = fakeHost();
    const engine = new MastraWorkflowEngine(brain.store, host, join(dir, "mastra-gate-late"));
    const runId = start(engine, w, wf("gate-and-job", { g: gateJob([]), j: readJob([]) }), "gate-and-job-1");
    await engine.settle();
    engine.completeStep(w.org, w.workspaceId, runId, "j", { error: "boom" }, false);
    expect(runState(brain, w, runId)).toBe("failed");
    expect(() => engine.wakeGate(w.org, w.workspaceId, host.approvals[0]!, true)).not.toThrow();
    await engine.settle();
    expect(runState(brain, w, runId)).toBe("failed");
    brain.close();
  }, scaled(120_000));

  it("a crash between a completion and the admission it unblocks is recovered once, without a second job", async () => {
    const { brain, dir } = tempBrain();
    const w = setupWorld(brain);
    const host = fakeHost();
    const storage = join(dir, "mastra-recover");
    const engine = new MastraWorkflowEngine(brain.store, host, storage);
    const runId = start(engine, w, fan(), "recover-1");
    await engine.settle();
    engine.completeStep(w.org, w.workspaceId, runId, "a", { a: 1 }, true);
    host.failNextJobFor = "c";
    // The Governor stops while admitting the join: b's completion is on record, c has no job.
    expect(() => engine.completeStep(w.org, w.workspaceId, runId, "b", { b: 1 }, true)).toThrow(/stopped while admitting/);
    expect(host.jobs).toEqual(["a", "b"]);
    const restarted = new MastraWorkflowEngine(brain.store, host, storage);
    restarted.recoverRun(w.org, w.workspaceId, runId);
    restarted.recoverRun(w.org, w.workspaceId, runId);
    expect([...host.jobs].sort()).toEqual(["a", "b", "c"]);
    restarted.completeStep(w.org, w.workspaceId, runId, "c", { c: 1 }, true);
    await restarted.settle();
    expect(runState(brain, w, runId)).toBe("succeeded");
    brain.close();
  }, scaled(120_000));
});
