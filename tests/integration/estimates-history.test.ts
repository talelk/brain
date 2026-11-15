import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandReceipt, Mission, PlanEstimate, PlanTask } from "@brain/contracts";
import { Brain } from "../../apps/governor/src/application/brain";
import { quantile } from "../../apps/governor/src/modules/missions/estimate";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { pastRun as past, seedPastRunner, type PastRuns } from "../support/past-runs";

// #132: plan estimates come from the median of past completed runs of the same Play task or the same workflow, and say so. Every past run is
// real: a mission whose task is linked to a run, claimed by a runner, settled in the usage ledger and finished through commands.

type World = ReturnType<typeof setupWorld>;
const PLAY = "weekly-status";
const worlds: Array<{ w: World; dir: string }> = [];
afterEach(() => { for (const { w, dir } of worlds.splice(0)) { w.brain.close(); rmSync(dir, { recursive: true, force: true }); } });

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const missionOf = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;
const estimateOf = async (w: World, planId: string): Promise<PlanEstimate> => ((await w.brain.executeQuery(w.owner, { queryType: "plans.estimate", workspaceId: w.workspaceId, resourceId: planId })) as unknown as { snapshot: PlanEstimate }).snapshot;
const planIds = (w: World, missionId: string) => (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id FROM plan_versions WHERE mission_id=? ORDER BY revision").all(missionId) as Array<{ id: string }>).map((row) => row.id);

/** A Governor on a controllable clock with the starter release (its Plays) and one runner able to take the jobs of past runs. */
function world() {
  const clock = { now: Date.now() };
  const dir = mkdtempSync(join(tmpdir(), "brain-test-estimates-"));
  const w = setupWorld(new Brain({ dataDir: dir, allowTestActor: true, clock: { nowMs: () => clock.now, monotonicMs: () => clock.now } }));
  worlds.push({ w, dir });
  const bundle = fixtureStarter();
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  return { w, runner: seedPastRunner(w), advance: (ms: number) => { clock.now += ms; }, count: { value: 0 } } satisfies PastRuns;
}
type Ctx = ReturnType<typeof world>;
const pastRun = (ctx: Ctx, input: { play?: boolean; task: PlanTask; minutes: number; microUsd: number }) => past(ctx, { ...(input.play ? { playId: PLAY } : {}), task: input.task, minutes: input.minutes, microUsd: input.microUsd });

/** A new mission from the Play (its starting plan proposed, never confirmed) whose estimate is read. */
async function playEstimate(ctx: Ctx, key: string): Promise<{ missionId: string; estimate: PlanEstimate }> {
  const missionId = (await run(ctx.w, "mission.create", `${key}-create`, { title: `Next ${key}`, playId: PLAY, autoStart: false })).resourceId ?? "";
  return { missionId, estimate: await estimateOf(ctx.w, planIds(ctx.w, missionId)[0]!) };
}
const collect = (ctx: Ctx): PlanTask => {
  const planned = JSON.parse((ctx.w.brain.store.workspaceDb(ctx.w.workspaceId, ctx.w.org).prepare("SELECT tasks_json FROM plan_versions WHERE mission_id=(SELECT id FROM missions WHERE play_id=? LIMIT 1)").get(PLAY) as { tasks_json: string } | undefined)?.tasks_json ?? "[]") as PlanTask[];
  return planned.find((task) => task.id === "collect")!;
};
const collectTask = async (ctx: Ctx): Promise<PlanTask> => {
  await run(ctx.w, "mission.create", "probe-create", { title: "Probe", playId: PLAY, autoStart: false });
  return collect(ctx);
};
const taskFigure = (estimate: PlanEstimate, id: string) => estimate.tasks.find((task) => task.taskId === id)!;

describe("quantiles", () => {
  it("takes the middle value, interpolates between neighbours and rounds to a whole number", () => {
    expect(quantile([5], 0.5)).toBe(5);
    expect(quantile([2, 4, 6, 10, 20], 0.5)).toBe(6);
    expect(quantile([2, 4, 6, 10, 20], 0.25)).toBe(4);
    expect(quantile([2, 4, 6, 10, 20], 0.75)).toBe(10);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(3); // 2.5 rounds up
    expect(quantile([10, 20], 0.25)).toBe(13); // 12.5 rounds up
  });
});

describe("plan estimates from history (#132)", () => {
  it("falls back to what the planner declared with fewer than three completed runs, and to unknown with neither", async () => {
    const ctx = world();
    const { estimate: first } = await playEstimate(ctx, "none");
    expect(taskFigure(first, "collect")).toMatchObject({ estimatedMinutes: 8, timeBasis: { kind: "declared" } });
    expect(first.timeBasis).toMatchObject({ kind: "declared" });
    expect(first.timeBasis).not.toHaveProperty("runs");
    expect(first).not.toHaveProperty("suggestedWallClockMs");

    const task = await collectTask(ctx);
    await pastRun(ctx, { play: true, task, minutes: 30, microUsd: 900 });
    await pastRun(ctx, { play: true, task, minutes: 40, microUsd: 700 });
    const { estimate: two } = await playEstimate(ctx, "two");
    expect(taskFigure(two, "collect")).toMatchObject({ estimatedMinutes: 8, timeBasis: { kind: "declared" } }); // two runs are too few

    // A plan with no declared value and no history says unknown, never zero.
    const bare = (await run(ctx.w, "mission.create", "bare-create", { title: "Bare", intent: "Nothing known", successCriteria: ["done"] })).resourceId ?? "";
    const barePlan = (await run(ctx.w, "plan.propose", "bare-plan", { missionId: bare, origin: "manual", tasks: [{ id: "x", title: "X", criteria: ["x"], dependsOn: [] }] })).resourceId ?? "";
    const none = await estimateOf(ctx.w, barePlan);
    expect(none).toMatchObject({ unknownMinutesTasks: 1, unknownCostTasks: 1, timeBasis: { kind: "unknown" }, costBasis: { kind: "unknown" } });
    expect(none).not.toHaveProperty("totalEstimatedMinutes"); expect(none).not.toHaveProperty("totalMicroUsd");
  }, 60_000);

  it("uses the median of three runs of the same Play task, with no range yet, and from four runs the 25th to 75th percentile", async () => {
    const ctx = world();
    const task = await collectTask(ctx);
    for (const [minutes, microUsd] of [[10, 300], [4, 100], [6, 200]] as const) await pastRun(ctx, { play: true, task, minutes, microUsd });
    const three = (await playEstimate(ctx, "three")).estimate;
    expect(taskFigure(three, "collect")).toMatchObject({ estimatedMinutes: 6, microUsd: 200, timeBasis: { kind: "history", runs: 3, source: "play-task" }, costBasis: { kind: "history", runs: 3, source: "play-task" } });
    expect(taskFigure(three, "collect").timeBasis).not.toHaveProperty("low");
    expect(three).toMatchObject({ timeBasis: { kind: "mixed" } }); // the Play's other tasks still rest on the planner's figures
    await pastRun(ctx, { play: true, task, minutes: 20, microUsd: 600 });
    await pastRun(ctx, { play: true, task, minutes: 2, microUsd: 50 });
    const five = (await playEstimate(ctx, "five")).estimate;
    // Minutes 2, 4, 6, 10, 20: median 6, 25th percentile 4, 75th percentile 10. Dollars 50, 100, 200, 300, 600.
    expect(taskFigure(five, "collect")).toMatchObject({ estimatedMinutes: 6, microUsd: 200, timeBasis: { kind: "history", runs: 5, low: 4, high: 10 }, costBasis: { kind: "history", runs: 5, low: 100, high: 300 } });
    // The plan's total keeps the declared figures of the other tasks and sums the ranges.
    const others = five.tasks.filter((entry) => entry.taskId !== "collect");
    expect(others.length).toBeGreaterThan(0);
    const declaredMinutes = others.reduce((sum, entry) => sum + (entry.estimatedMinutes ?? 0), 0);
    expect(five.totalEstimatedMinutes).toBe(6 + declaredMinutes);
    expect(five.timeBasis).toMatchObject({ kind: "mixed", runs: 5, low: 4 + declaredMinutes, high: 10 + declaredMinutes });
  }, 120_000);

  it("prefers the same Play task, then the same workflow, and counts only completed runs of this kind of work", async () => {
    const ctx = world();
    const flow = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [], workflowId: "general-task", ...extra });
    // Three runs of one workflow, whatever the task was called.
    for (const [id, minutes] of [["a", 30], ["b", 50], ["c", 40]] as const) await pastRun(ctx, { task: flow(id), minutes, microUsd: minutes * 10 });
    const mission = (await run(ctx.w, "mission.create", "wf-create", { title: "Workflow", intent: "Use history", successCriteria: ["done"] })).resourceId ?? "";
    const plan = (await run(ctx.w, "plan.propose", "wf-plan", { missionId: mission, origin: "manual", tasks: [flow("z"), { id: "plain", title: "Plain", criteria: ["p"], dependsOn: [], workflowId: "weekly-report", estimatedMinutes: 9 }] })).resourceId ?? "";
    const estimate = await estimateOf(ctx.w, plan);
    expect(taskFigure(estimate, "z")).toMatchObject({ estimatedMinutes: 40, microUsd: 400, timeBasis: { kind: "history", runs: 3, source: "workflow" } });
    expect(taskFigure(estimate, "plain")).toMatchObject({ estimatedMinutes: 9, timeBasis: { kind: "declared" } }); // another workflow's runs say nothing about it
    expect(estimate).toMatchObject({ totalEstimatedMinutes: 49, timeBasis: { kind: "mixed", runs: 3 }, unknownCostTasks: 1, costBasis: { kind: "history", runs: 3 } });
    expect(estimate.suggestedWallClockMs).toBeGreaterThan(0);

    // A task that names no workflow runs on the default one (general-task), so it shares those runs' history.
    const unnamed = (await run(ctx.w, "plan.propose", "wf-plan-2", { missionId: mission, origin: "manual", tasks: [{ id: "unnamed", title: "Unnamed", criteria: ["u"], dependsOn: [] }] })).resourceId ?? "";
    expect(taskFigure(await estimateOf(ctx.w, unnamed), "unnamed")).toMatchObject({ estimatedMinutes: 40, timeBasis: { kind: "history", runs: 3, source: "workflow" } });

    // The same Play task with three runs of its own wins over the workflow its task also names.
    const task = { ...(await collectTask(ctx)), workflowId: "general-task" };
    for (const minutes of [1, 2, 3]) await pastRun(ctx, { play: true, task, minutes, microUsd: minutes });
    const played = (await playEstimate(ctx, "play")).estimate;
    expect(taskFigure(played, "collect").timeBasis).toMatchObject({ kind: "history", source: "play-task", runs: 3 });
    expect(taskFigure(played, "collect").estimatedMinutes).toBe(2);
  }, 180_000);

  it("never changes a budget: the suggestion is only an offer, and a person's saved value is the ceiling", async () => {
    const ctx = world();
    const task = await collectTask(ctx);
    for (const [minutes, microUsd] of [[10, 3000], [10, 4000], [20, 5000], [30, 6000]] as const) await pastRun(ctx, { play: true, task, minutes, microUsd });
    const next = await run(ctx.w, "mission.create", "next-create", { title: "Next", playId: PLAY, autoStart: false, budget: { maxMicroUsd: 90_000, finalAllowanceMicroUsd: 5000, memberCap: 3 } });
    const missionId = next.resourceId ?? "";
    const before = await missionOf(ctx.w, missionId);
    const estimate = await estimateOf(ctx.w, planIds(ctx.w, missionId)[0]!);
    expect(estimate).toMatchObject({ costBasis: { kind: "history", runs: 4 } }); expect(estimate.unknownCostTasks).toBeGreaterThan(0); // the other tasks declared no cost: unknown, not zero
    expect(estimate.suggestedMicroUsd).toBe((taskFigure(estimate, "collect").costBasis?.high ?? 0) + 5000);
    expect(estimate.suggestedWallClockMs).toBeGreaterThan(0);
    expect(estimate.ceilingMicroUsd).toBe(85_000); // the human-set budget less the final allowance, untouched by the suggestion
    const after = await missionOf(ctx.w, missionId);
    expect(after.budget).toEqual(before.budget);
    expect(after.version).toBe(before.version);
    await run(ctx.w, "plan.confirm", "next-confirm", { planVersionId: planIds(ctx.w, missionId)[0]! }, after.version);
    expect((await missionOf(ctx.w, missionId)).budget.maxMicroUsd).toBe(90_000);
  }, 120_000);
});
