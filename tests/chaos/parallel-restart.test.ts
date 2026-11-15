import { afterEach, describe, expect, it, vi } from "vitest";
import { Brain } from "../../apps/governor/src/application/brain";
import { setupWorld } from "../helpers";
import { parallelTriage, settled, TRIAGE_OUTPUT } from "../support/parallel-workflow";
import { fixtureStarter } from "../support/starter";
import { scaled } from "../support/timing";

// A Governor killed in the middle of a run with parallel steps (ADR 0043): after the restart each step still has
// exactly one job, a completion recorded before the kill is not repeated, the join starts once, and the run ends.
type World = ReturnType<typeof setupWorld>;
const open: Brain[] = [];
afterEach(() => { for (const brain of open.splice(0)) brain.close(); });

async function dispatchParallel(w: World): Promise<string> {
  const bundle = fixtureStarter();
  bundle.documents.push(parallelTriage(bundle.documents));
  const { digest } = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
  w.brain.activateRelease(w.owner, digest);
  const { receipt } = await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: "cmd-par", commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: "par-1",
    payload: { workflow: { id: "triage-parallel", digest }, input: { situation: "Error rates rose after a deploy." } },
  }, "par-1");
  return receipt.resourceId!;
}
const jobsOf = (brain: Brain, runId: string) => brain.store.control.prepare("SELECT step_id AS step, state FROM jobs WHERE workflow_run_id=? ORDER BY step_id").all(runId) as Array<{ step: string; state: string }>;
const runStateOf = (brain: Brain, w: World, runId: string) => (brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state;
const finish = (brain: Brain, w: World, runId: string, step: string) => brain.workflows.completeStep(w.org, w.workspaceId, runId, step, TRIAGE_OUTPUT, true);
async function reopen(w: World): Promise<Brain> {
  const brain = new Brain({ dataDir: w.dir, allowTestActor: true });
  open.push(brain);
  return brain;
}

describe("a Governor killed during a run with parallel steps", () => {
  it("resumes each step once: finished branches stay finished, the others are completed after the restart, and the join starts once", async () => {
    const w = setupWorld();
    open.push(w.brain);
    const runId = await dispatchParallel(w);
    expect(jobsOf(w.brain, runId)).toEqual([{ step: "left", state: "queued" }, { step: "right", state: "queued" }, { step: "third", state: "queued" }]);
    finish(w.brain, w, runId, "right");
    finish(w.brain, w, runId, "left");
    // Killed: the process ends while the engine is idle (a dead process runs nothing more) and a new one opens the same data directory.
    await settled(w.brain);
    w.brain.close();
    open.splice(0, 1);
    const restarted = await reopen(w);
    expect(runStateOf(restarted, w, runId)).toBe("running");
    expect(jobsOf(restarted, runId).filter((job) => job.step === "join")).toEqual([]);

    // A completion already on record is immutable; repeating it changes nothing.
    finish(restarted, w, runId, "left");
    await settled(restarted);
    expect(jobsOf(restarted, runId).filter((job) => job.step === "join")).toEqual([]);

    finish(restarted, w, runId, "third");
    await settled(restarted);
    expect(jobsOf(restarted, runId).filter((job) => job.step === "join")).toEqual([{ step: "join", state: "queued" }]);
    finish(restarted, w, runId, "join");
    await settled(restarted);
    expect(runStateOf(restarted, w, runId)).toBe("succeeded");
    expect(jobsOf(restarted, runId).map((job) => job.step)).toEqual(["join", "left", "right", "third"]);
  }, scaled(60_000));

  it("a kill between the last branch finishing and the join being admitted is recovered by the first maintenance pass, once", async () => {
    const w = setupWorld();
    open.push(w.brain);
    const runId = await dispatchParallel(w);
    finish(w.brain, w, runId, "left");
    finish(w.brain, w, runId, "right");
    // The process dies while admitting the join: the third branch's completion is durable, the join has no job.
    const create = vi.spyOn(w.brain.jobProtocol, "createForStep").mockImplementationOnce(() => { throw new Error("killed while admitting the join"); });
    expect(() => finish(w.brain, w, runId, "third")).toThrow(/killed while admitting/);
    create.mockRestore();
    expect(jobsOf(w.brain, runId).filter((job) => job.step === "join")).toEqual([]);
    await settled(w.brain);
    w.brain.close();
    open.splice(0, 1);

    const restarted = await reopen(w);
    restarted.projectOutbox();
    restarted.projectOutbox();
    await settled(restarted);
    expect(jobsOf(restarted, runId).filter((job) => job.step === "join")).toEqual([{ step: "join", state: "queued" }]);
    finish(restarted, w, runId, "join");
    await settled(restarted);
    expect(runStateOf(restarted, w, runId)).toBe("succeeded");
  }, scaled(60_000));
});
