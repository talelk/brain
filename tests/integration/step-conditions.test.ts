import { afterEach, describe, expect, it } from "vitest";
import type { Brain } from "../../apps/governor/src/application/brain";
import { setupWorld } from "../helpers";
import { settled, TRIAGE_OUTPUT } from "../support/parallel-workflow";
import { fixtureStarter } from "../support/starter";

// A step's `when` condition (ADR 0046), at the Governor boundary: the workflow is released and dispatched by command, steps finish through
// the engine port, and the run's steps and jobs are read back. The condition reads the output of an earlier step of the step's own chain.
type World = ReturnType<typeof setupWorld>;
const open: Brain[] = [];
afterEach(() => { for (const brain of open.splice(0)) brain.close(); });

type Step = Record<string, unknown>;
/** The starter's triage workflow with its one `respond` step cloned into the steps `build` names. */
function workflowOf(documents: ReadonlyArray<{ path: string; text: string }>, id: string, build: (respond: Step) => Record<string, Step>): { path: string; text: string } {
  const workflow = JSON.parse(documents.find((doc) => doc.path.endsWith("operations-triage.yaml"))!.text);
  workflow.metadata.id = id;
  workflow.spec.jobs = build(workflow.spec.jobs["respond"]);
  workflow.spec.outputs = { passed: { source: "literal", value: true } };
  return { path: `config/${id}.yaml`, text: JSON.stringify(workflow, null, 2) + "\n" };
}
const when = (pointer: string, equals?: unknown) => ({ step: "first", pointer, ...(equals === undefined ? {} : { equals }) });
/** first -> branch (when) -> after; first -> side; branch + side -> join. */
const branching = (condition: unknown) => (respond: Step): Record<string, Step> => ({
  first: respond,
  branch: { ...respond, needs: ["first"], when: condition },
  after: { ...respond, needs: ["branch"] },
  side: { ...respond, needs: ["first"] },
  join: { ...respond, needs: ["branch", "side"] },
});

function stage(w: World, id: string, build: (respond: Step) => Record<string, Step>): string {
  const bundle = fixtureStarter();
  bundle.documents.push(workflowOf(bundle.documents, id, build));
  const { digest } = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
  w.brain.activateRelease(w.owner, digest);
  return digest;
}
async function dispatch(w: World, id: string, digest: string): Promise<string> {
  const { receipt } = await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${id}`, commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: `key-${id}`,
    payload: { workflow: { id, digest }, input: { situation: "Error rates rose after a deploy." } },
  }, `key-${id}`);
  return receipt.resourceId!;
}
const jobSteps = (brain: Brain, runId: string) => (brain.store.control.prepare("SELECT step_id AS step FROM jobs WHERE workflow_run_id=? ORDER BY step_id").all(runId) as Array<{ step: string }>).map((job) => job.step);
const stepStates = (brain: Brain, w: World, runId: string) => Object.fromEntries((brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT step_id, state FROM workflow_steps WHERE run_id=?").all(runId) as Array<{ step_id: string; state: string }>).map((r) => [r.step_id, r.state]));
const runState = (brain: Brain, w: World, runId: string) => (brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state;
const finish = async (w: World, runId: string, step: string, output: unknown = TRIAGE_OUTPUT) => { w.brain.workflows.completeStep(w.org, w.workspaceId, runId, step, output as never, true); await settled(w.brain); };

async function start(condition: unknown): Promise<{ w: World; runId: string }> {
  const w = setupWorld();
  open.push(w.brain);
  const digest = stage(w, "conditional", branching(condition));
  return { w, runId: await dispatch(w, "conditional", digest) };
}

describe("a step with a when condition", () => {
  it("runs when the output of the step it names equals the declared value", async () => {
    const { w, runId } = await start(when("/summary", "Triaged"));
    expect(jobSteps(w.brain, runId)).toEqual(["first"]);
    await finish(w, runId, "first");
    expect(jobSteps(w.brain, runId)).toEqual(["branch", "first", "side"]);
    await finish(w, runId, "branch");
    await finish(w, runId, "side");
    expect(jobSteps(w.brain, runId)).toEqual(["after", "branch", "first", "join", "side"]);
    await finish(w, runId, "after");
    await finish(w, runId, "join");
    expect(Object.values(stepStates(w.brain, w, runId)).every((state) => state === "succeeded")).toBe(true);
    expect(runState(w.brain, w, runId)).toBe("succeeded");
  });

  it("skips the step when the value differs, skips what depends on it, and still runs the independent branch to a succeeded run", async () => {
    const { w, runId } = await start(when("/summary", "Something else"));
    await finish(w, runId, "first");
    // The skipped step started no job, and neither did the steps below it; the independent branch started.
    expect(jobSteps(w.brain, runId)).toEqual(["first", "side"]);
    expect(stepStates(w.brain, w, runId)).toEqual({ first: "succeeded", branch: "skipped", after: "skipped", side: "running", join: "skipped" });
    expect(runState(w.brain, w, runId)).toBe("running");
    await finish(w, runId, "side");
    // A branch not taken is not a failure and not a shortfall: the run succeeds.
    expect(stepStates(w.brain, w, runId)).toEqual({ first: "succeeded", branch: "skipped", after: "skipped", side: "succeeded", join: "skipped" });
    expect(runState(w.brain, w, runId)).toBe("succeeded");
    expect(jobSteps(w.brain, runId)).toEqual(["first", "side"]);
  });

  it("without equals, tests only that the pointer exists in the output", async () => {
    const present = await start(when("/blockers"));
    await finish(present.w, present.runId, "first");
    expect(jobSteps(present.w.brain, present.runId)).toEqual(["branch", "first", "side"]);
    const absent = await start(when("/nothing-here"));
    await finish(absent.w, absent.runId, "first");
    expect(jobSteps(absent.w.brain, absent.runId)).toEqual(["first", "side"]);
    expect(stepStates(absent.w.brain, absent.w, absent.runId)["branch"]).toBe("skipped");
  });

  it("compares structured values, whatever the order of their keys", async () => {
    const equal = await start(when("", { nextActions: [], blockers: [], summary: "Triaged" }));
    await finish(equal.w, equal.runId, "first");
    expect(jobSteps(equal.w.brain, equal.runId)).toContain("branch");
    const different = await start(when("/blockers", ["x"]));
    await finish(different.w, different.runId, "first");
    expect(jobSteps(different.w.brain, different.runId)).not.toContain("branch");
  });

  it("settles the run at once when the only remaining steps are skipped", async () => {
    const w = setupWorld();
    open.push(w.brain);
    const digest = stage(w, "tail", (respond) => ({ first: respond, last: { ...respond, needs: ["first"], when: when("/summary", "No") } }));
    const runId = await dispatch(w, "tail", digest);
    await finish(w, runId, "first");
    expect(stepStates(w.brain, w, runId)).toEqual({ first: "succeeded", last: "skipped" });
    expect(runState(w.brain, w, runId)).toBe("succeeded");
  });
});

describe("a when condition is checked when the release is compiled", () => {
  const stageWith = (build: (respond: Step) => Record<string, Step>) => { const w = setupWorld(); open.push(w.brain); return () => stage(w, "bad", build); };

  it("refuses a step that does not exist", () => {
    expect(stageWith((respond) => ({ first: respond, next: { ...respond, needs: ["first"], when: { step: "ghost", pointer: "/summary" } } }))).toThrow(/unknown step ghost/);
  });
  it("refuses a step the condition's owner does not depend on, directly or through another step", () => {
    expect(stageWith((respond) => ({ first: respond, other: respond, next: { ...respond, needs: ["first"], when: { step: "other", pointer: "/summary" } } }))).toThrow(/does not need/);
  });
  it("accepts a step the owner reaches through another step", () => {
    expect(stageWith((respond) => ({ first: respond, middle: { ...respond, needs: ["first"] }, last: { ...respond, needs: ["middle"], when: when("/summary", "Triaged") } }))).not.toThrow();
  });
  it("refuses a pointer that is not a JSON pointer", () => {
    expect(stageWith((respond) => ({ first: respond, next: { ...respond, needs: ["first"], when: { step: "first", pointer: "summary" } } }))).toThrow(/invalid when condition/);
  });
  it("refuses a condition on an evaluation step, which judges the evidence of its needs", () => {
    expect(stageWith((respond) => ({ first: respond, judge: { kind: "eval", needs: ["first"], when: when("/summary") } }))).toThrow(/cannot have a when condition/);
  });
  it("refuses a retry or a timeout on a step that runs no job, instead of ignoring it", () => {
    expect(stageWith((respond) => ({ first: respond, ask: { kind: "gate", needs: ["first"], input: {}, proposalFrom: { source: "literal", value: 1 }, retry: { maxAttempts: 2, classes: ["transient-read"], initialDelayMs: 100, maxDelayMs: 200 } } }))).toThrow(/runs no job/);
  });
  it("refuses a retry that cannot be honoured: delays out of order, or a number of attempts out of range", () => {
    expect(stageWith((respond) => ({ first: { ...respond, retry: { maxAttempts: 2, classes: ["transient-read"], initialDelayMs: 500, maxDelayMs: 100 } } }))).toThrow(/exceeds maxDelayMs/);
    expect(stageWith((respond) => ({ first: { ...respond, retry: { maxAttempts: 9, classes: [], initialDelayMs: 100, maxDelayMs: 200 } } }))).toThrow(/invalid retry policy/);
  });
});
