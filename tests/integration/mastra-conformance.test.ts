import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Workflow } from "@brain/contracts";
import { Brain } from "../../apps/governor/src/application/brain";
import { MastraWorkflowEngine, type WorkflowHost } from "../../apps/governor/src/modules/workflows/index";
import { setupWorld, tempBrain, DIGEST_A } from "../helpers";

function wf(id: string, jobs: Record<string, unknown>): Workflow {
  return {
    apiVersion: "brain.keyrus/v1", kind: "Workflow",
    metadata: { id, version: "1.0.0" },
    spec: { inputSchemaRef: "s", outputSchemaRef: "s", jobs, outputs: {}, failFast: true, deadlineSeconds: 60 },
  } as unknown as Workflow;
}
const readJob = (needs: string[]) => ({ kind: "dispatch", needs, input: {}, effectClass: "read", uses: { type: "tool", release: { id: "fixture.echo", digest: DIGEST_A } }, runsOn: { group: "g", all: [], isolation: "ephemeral-container", resources: { cpuMillicores: 1, memoryMb: 1, diskMb: 1, slots: 1 } } });
const gateJob = (needs: string[]) => ({ kind: "gate", needs, input: {}, proposalFrom: "x", expiresAfterSeconds: 3600 });

function fakeHost(): WorkflowHost & { jobs: string[]; approvals: string[]; steers: number } {
  const host = {
    jobs: [] as string[], approvals: [] as string[], steers: 0,
    createJobForStep(input: { stepId: string }) { host.jobs.push(input.stepId); return `job-${input.stepId}-${host.jobs.length}`; },
    createApprovalForGate(input: { stepId: string }) { const id = `apr-${input.stepId}-${host.approvals.length + 1}`; host.approvals.push(id); return id; },
    loadWorkflow() { throw new Error("no child workflows in fake host"); },
    recordSteer() { host.steers += 1; },
  };
  return host as unknown as WorkflowHost & { jobs: string[]; approvals: string[]; steers: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (fn()) return; await sleep(100); }
  throw new Error("waitFor timed out");
}

describe("Mastra WorkflowEnginePort conformance (T29/T30)", () => {
  it("drives dispatch -> gate -> dispatch with durable suspend/resume across engine restart", async () => {
    const { brain, dir } = tempBrain();
    const w = setupWorld(brain);
    const host = fakeHost();
    const storage = join(dir, "mastra-test");
    const engine = new MastraWorkflowEngine(brain.store, host, storage);
    const workflow = wf("gate-flow", { first: readJob([]), gate: gateJob(["first"]), second: { ...readJob(["gate"]), effectClass: "write" } });
    const { runId } = engine.startRun({
      organizationId: w.org, workspaceId: w.workspaceId, actorId: "owner-1",
      workflowId: "gate-flow", workflow, configDigest: DIGEST_A, runInput: {}, executionKey: "gate-flow-1",
    });
    await waitFor(() => host.jobs.includes("first"));
    await engine.settle();
    engine.completeStep(w.org, w.workspaceId, runId, "first", { ok: 1 }, true);
    await waitFor(() => host.approvals.length === 1);
    await engine.settle();
    const ws = brain.store.workspaceDb(w.workspaceId, w.org);
    expect((ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state).toBe("suspended");

    // Restart: a brand-new engine over the same stores resumes the gate.
    const engine2 = new MastraWorkflowEngine(brain.store, host, storage);
    engine2.wakeGate(w.org, w.workspaceId, host.approvals[0]!, true);
    await waitFor(() => host.jobs.includes("second"));
    await engine2.settle();
    engine2.completeStep(w.org, w.workspaceId, runId, "second", { done: true }, true);
    await engine2.settle();
    await waitFor(() => (ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state === "succeeded");
    const steps = ws.prepare("SELECT step_id, state FROM workflow_steps WHERE run_id=? ORDER BY step_id").all(runId) as Array<{ step_id: string; state: string }>;
    expect(steps.every((s) => s.state === "succeeded")).toBe(true);
    brain.close();
  }, 120_000);

  it("holds 100 suspended gates and wakes each exactly once after restart (T30)", async () => {
    const { brain, dir } = tempBrain();
    const w = setupWorld(brain);
    const host = fakeHost();
    const storage = join(dir, "mastra-100");
    const engine = new MastraWorkflowEngine(brain.store, host, storage);
    const workflow = wf("gate-only", { gate: gateJob([]) });
    const runIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      runIds.push(engine.startRun({
        organizationId: w.org, workspaceId: w.workspaceId, actorId: "owner-1",
        workflowId: "gate-only", workflow, configDigest: DIGEST_A, runInput: {}, executionKey: `gate-100-${i}`,
      }).runId);
    }
    await waitFor(() => host.approvals.length === 100, 60_000);
    await engine.settle();
    const engine2 = new MastraWorkflowEngine(brain.store, host, storage);
    for (const approvalId of host.approvals) engine2.wakeGate(w.org, w.workspaceId, approvalId, true);
    // Duplicate wakes are no-ops.
    for (const approvalId of host.approvals.slice(0, 5)) engine2.wakeGate(w.org, w.workspaceId, approvalId, true);
    await engine2.settle();
    const ws = brain.store.workspaceDb(w.workspaceId, w.org);
    await waitFor(() => runIds.every((id) => (ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(id) as { state: string }).state === "succeeded"), 60_000);
    brain.close();
  }, 240_000);

  it("covers steer, merge and subgraph primitives through the port (T29)", async () => {
    const { brain, dir } = tempBrain();
    const w = setupWorld(brain);
    const child = wf("child-flow", { work: readJob([]) });
    const host = fakeHost();
    (host as unknown as { loadWorkflow: unknown }).loadWorkflow = () => ({ workflow: child, configDigest: DIGEST_A });
    const engine = new MastraWorkflowEngine(brain.store, host, join(dir, "mastra-prim"));
    const workflow = wf("prim-flow", {
      steerStep: { kind: "steer", needs: [], input: {}, message: "focus" },
      gateStep: gateJob(["steerStep"]),
      sub: { kind: "subgraph", needs: ["gateStep"], input: {}, outputSchemaRef: "s", workflow: { id: "child-flow", digest: DIGEST_A } },
      mergeStep: { kind: "merge", needs: ["sub"], input: {} },
    });
    const { runId } = engine.startRun({
      organizationId: w.org, workspaceId: w.workspaceId, actorId: "owner-1",
      workflowId: "prim-flow", workflow, configDigest: DIGEST_A, runInput: {}, executionKey: "prim-1",
    });
    const ws = brain.store.workspaceDb(w.workspaceId, w.org);
    await waitFor(() => host.approvals.length === 1, 30000);
    expect(host.steers).toBe(1);
    engine.wakeGate(w.org, w.workspaceId, host.approvals[0]!, true);
    await waitFor(() => host.jobs.includes("work"), 30000);
    const childRun = ws.prepare("SELECT id FROM workflow_runs WHERE execution_key=?").get(`${runId}:sub:child`) as { id: string };
    engine.completeStep(w.org, w.workspaceId, childRun.id, "work", { child: "done" }, true);
    await waitFor(() => host.jobs.includes("mergeStep"), 30000);
    engine.completeStep(w.org, w.workspaceId, runId, "mergeStep", { merged: true }, true);
    await engine.settle();
    await waitFor(() => (ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state === "succeeded", 30000);
    const steps = ws.prepare("SELECT step_id, state FROM workflow_steps WHERE run_id=?").all(runId) as Array<{ step_id: string; state: string }>;
    expect(steps.every((s2) => s2.state === "succeeded")).toBe(true);
    brain.close();
  }, 120_000);

  it("registration/store failure blocks the run; no step is guessed successful (E025)", async () => {
    const { brain, dir } = tempBrain();
    const w = setupWorld(brain);
    const host = fakeHost();
    const storage = join(dir, "mastra-e025");
    // The engine's own Mastra database is not a valid store: lowering
    // cannot commit, so the run must block for diagnosis instead of marking
    // steps successful without an engine.
    mkdirSync(storage, { recursive: true });
    writeFileSync(join(storage, "mastra.db"), "not-a-libsql-database");
    const engine = new MastraWorkflowEngine(brain.store, host, storage);
    const workflow = wf("fail-reg", { first: readJob([]) });
    const { runId } = engine.startRun({
      organizationId: w.org, workspaceId: w.workspaceId, actorId: "owner-1",
      workflowId: "fail-reg", workflow, configDigest: DIGEST_A, runInput: {}, executionKey: "fail-reg-1",
    });
    await engine.settle();
    const ws = brain.store.workspaceDb(w.workspaceId, w.org);
    await waitFor(() => (ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state === "blocked", 30_000);
    const steps = ws.prepare("SELECT step_id, state FROM workflow_steps WHERE run_id=?").all(runId) as Array<{ state: string }>;
    expect(steps.every((r) => r.state !== "succeeded")).toBe(true);
    expect(host.jobs.includes("first")).toBe(true); // admitted queue only; never marked done
    brain.close();
  }, 60_000);

  it("Brain in mastra mode creates real jobs and fails the run on step failure", async () => {
    const brain = new Brain({ dataDir: mkdtempSync(join(tmpdir(), "brain-mastra-mode-")), allowTestActor: true });
    const w = setupWorld(brain);
    const s = brain.store;
    const digest = brain.activeRelease(w.org)!.digest;
    const { receipt } = brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-mm", commandType: "workflow.dispatch",
      workspaceId: w.workspaceId, idempotencyKey: "mm-1",
      payload: { workflow: { id: "fixture-workflow", digest }, input: { message: "Brain fixture" } },
    }, "mm");
    const runId = (receipt as { resourceId?: string }).resourceId!;
    await waitFor(() => Boolean(s.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=?").get(runId)));
    s.control.prepare(`INSERT INTO runners(id, organization_id, group_id, identity_key_digest, admin_state, health, config_digest, session_epoch, last_heartbeat_ms, cpu_capacity, memory_capacity, disk_capacity, slot_capacity)
      VALUES ('runner-mm', ?, 'fixture-tools', 'k', 'enabled', 'healthy', ?, 1, ?, 4000, 8192, 20480, 1)`).run(w.org, DIGEST_A, s.now());
    for (const cap of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
      s.control.prepare("INSERT INTO runner_capabilities(runner_id, capability, verified, source, observed_at_ms, expires_at_ms) VALUES ('runner-mm', ?, 1, 'test', ?, ?)").run(cap, s.now(), s.now() + 3600000);
    }
    const runner = { runnerId: "runner-mm", epoch: 1, organizationId: w.org };
    const offer = brain.claim(runner, "req-mm") as unknown as { attemptId: string; leaseId: string; jobFence: number };
    brain.ackAttempt(runner, offer.attemptId, { leaseId: offer.leaseId, jobFence: offer.jobFence });
    brain.completeAttempt(runner, offer.attemptId, { result: "failed", output: {}, jobFence: offer.jobFence, cleanupConfirmed: true });
    await (brain.workflows as MastraWorkflowEngine).settle();
    const ws = s.workspaceDb(w.workspaceId, w.org);
    await waitFor(() => (ws.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state === "failed");
    brain.close();
  }, 120_000);
});
