import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandReceipt, Mission, PlanTask, WorkItem } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { fixtureGate } from "../../apps/runner/src/engines/fixture";
import { enrollAndHello, newRunnerControls, runOnce, type RunnerConfig } from "../../apps/runner/src/supervisor";
import { setupWorld } from "../helpers";
import { parallelTriage, TRIAGE_OUTPUT } from "../support/parallel-workflow";
import { fixtureStarter } from "../support/starter";
import { scaled } from "../support/timing";

// Parallel steps through the Governor (ADR 0043): a mission's run starts every ready step at once, the member cap
// stays the limit on attempts running together, the join waits for every branch, and a failed branch stops the run.
type App = Awaited<ReturnType<typeof createApp>>;
type World = ReturnType<typeof setupWorld>;
const savedSlots = process.env["BRAIN_RUNNER_SLOTS"];

async function until(done: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("condition not reached in time"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

describe("a mission's run with parallel steps", () => {
  let root: string; let app: App; let world: World; let cfg: RunnerConfig; let session: { token: string; epoch: number };
  const s = () => world.brain.store;
  const run = async (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> => (await world.brain.executeCommand(world.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: world.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
  const query = async <T>(queryType: string, resourceId: string): Promise<T> => ((await world.brain.executeQuery(world.owner, { queryType, workspaceId: world.workspaceId, resourceId })) as { snapshot: T }).snapshot;

  /** A mission with one task on the parallel workflow; confirming the plan starts its run. Returns the run id. */
  async function startMission(key: string, memberCap: number): Promise<string> {
    const task: PlanTask = { id: "t", title: "Triage in parallel", criteria: ["t-done"], dependsOn: [], workflowId: "triage-parallel" };
    const missionId = (await run("mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], budget: { maxMicroUsd: 5_000_000, memberCap } })).resourceId ?? "";
    const planId = (await run("plan.propose", `${key}-plan`, { missionId, origin: "manual", tasks: [task] })).resourceId ?? "";
    await run("plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await query<Mission>("missions.get", missionId)).version);
    const db = s().workspaceDb(world.workspaceId, world.org);
    const row = db.prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string };
    const item = await query<WorkItem>("workItems.get", row.id);
    expect(item.state).toBe("in-progress");
    return (db.prepare("SELECT run_id FROM execution_links WHERE work_item_id=?").get(row.id) as { run_id: string }).run_id;
  }
  const jobs = (runId: string) => s().control.prepare("SELECT step_id AS step, state, queue_reason AS reason FROM jobs WHERE workflow_run_id=? ORDER BY step_id").all(runId) as Array<{ step: string; state: string; reason: string | null }>;
  const runState = async (runId: string) => (await query<{ state: string }>("run.get", runId)).state;
  const finish = (runId: string, step: string, ok = true) => world.brain.workflows.completeStep(world.org, world.workspaceId, runId, step, ok ? TRIAGE_OUTPUT : { error: "the step failed" }, ok);

  beforeEach(async () => {
    process.env["BRAIN_RUNNER_SLOTS"] = "3";
    root = mkdtempSync(join(tmpdir(), "brain-parallel-"));
    app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
    world = setupWorld(app.brain);
    const bundle = fixtureStarter();
    bundle.documents.push(parallelTriage(bundle.documents));
    world.brain.activateRelease(world.owner, world.brain.stageRelease(world.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
    const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
    cfg = { governorUrl: "http://127.0.0.1:3000", runnerId: "runner-parallel", stateDir: join(root, "runner"), capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], engines: ["fixture"], transport };
    const hello = await enrollAndHello(cfg, world.brain.jobProtocol.issueEnrollment(world.owner, "agents").token);
    session = { token: hello.sessionToken, epoch: hello.epoch };
  }, scaled(60_000));
  afterEach(async () => {
    delete fixtureGate.hold;
    if (savedSlots === undefined) delete process.env["BRAIN_RUNNER_SLOTS"]; else process.env["BRAIN_RUNNER_SLOTS"] = savedSlots;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("queues every independent step at once, runs them up to the member cap, and starts the join only after all of them", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    let entered = 0; let waiting = 0;
    fixtureGate.hold = async () => { entered += 1; if (entered > 2) return; waiting += 1; await opened; };
    const runId = await startMission("cap", 2);

    // All three independent steps have a job the moment the run starts; the join has none yet.
    expect(jobs(runId)).toEqual([
      { step: "left", state: "queued", reason: "WAITING_FOR_RUNNER" }, { step: "right", state: "queued", reason: "WAITING_FOR_RUNNER" }, { step: "third", state: "queued", reason: "WAITING_FOR_RUNNER" },
    ]);

    // Two attempts of the same run work at the same time; the third waits for a free member, not for a runner slot.
    const controls = newRunnerControls();
    const claims = [runOnce(cfg, () => session.token, session.epoch, controls), runOnce(cfg, () => session.token, session.epoch, controls)];
    await until(() => waiting === 2);
    expect(await runOnce(cfg, () => session.token, session.epoch, controls)).toBe(false);
    const running = jobs(runId);
    expect(running.filter((job) => job.state === "running")).toHaveLength(2);
    expect(running.filter((job) => job.state === "queued")).toEqual([expect.objectContaining({ reason: "waiting: member cap" })]);

    // A finished attempt frees its member; the waiting step is then taken.
    open();
    expect(await Promise.all(claims)).toEqual([true, true]);
    expect(await runOnce(cfg, () => session.token, session.epoch, controls)).toBe(true);
    expect(jobs(runId).map((job) => job.state)).toEqual(["verifying", "verifying", "verifying"]);

    // The join waits for every branch, whichever finishes first, and is created once.
    finish(runId, "third");
    finish(runId, "left");
    expect(jobs(runId).some((job) => job.step === "join")).toBe(false);
    finish(runId, "right");
    await world.brain.workflows.settle();
    expect(jobs(runId).filter((job) => job.step === "join")).toEqual([{ step: "join", state: "queued", reason: "WAITING_FOR_RUNNER" }]);
    expect(await runState(runId)).toBe("running");
    finish(runId, "join");
    await world.brain.workflows.settle();
    expect(await runState(runId)).toBe("succeeded");
    expect(jobs(runId)).toHaveLength(4);
  }, scaled(60_000));

  it("a failed branch fails the run, withdraws the branches no runner holds and never starts the join", async () => {
    const runId = await startMission("fail", 3);
    const controls = newRunnerControls();
    expect(await runOnce(cfg, () => session.token, session.epoch, controls)).toBe(true);
    expect(jobs(runId).map((job) => job.state).sort()).toEqual(["queued", "queued", "verifying"]);
    const claimed = jobs(runId).find((job) => job.state === "verifying")!.step;

    finish(runId, claimed, false);
    await world.brain.workflows.settle();
    expect(await runState(runId)).toBe("failed");
    expect(jobs(runId).filter((job) => job.step !== claimed).map((job) => job.state)).toEqual(["cancelled", "cancelled"]);
    // Nothing is left for a runner to take, and a late completion of another branch moves nothing.
    expect(await runOnce(cfg, () => session.token, session.epoch, controls)).toBe(false);
    const other = jobs(runId).find((job) => job.step !== claimed)!.step;
    finish(runId, other);
    await world.brain.workflows.settle();
    expect(await runState(runId)).toBe("failed");
    expect(jobs(runId).some((job) => job.step === "join")).toBe(false);
  }, scaled(60_000));
});
