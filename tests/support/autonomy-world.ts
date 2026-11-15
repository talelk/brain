import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutonomySuggestion, AutonomySuggestions, CommandReceipt, Mission, PlanTask, WorkItem } from "../../packages/contracts/src/index";
import { Brain } from "../../apps/governor/src/application/brain";
import { setupWorld, workView, type TestWorld } from "../helpers";
import { fixtureStarter } from "./starter";
import { command } from "./reuse";
import { finishTask } from "./finish-task";

// A Governor on a controllable clock with the starter release, for autonomy suggestions (#158). Every record a suggestion rests on is made
// the way a person's work makes it: missions and plans through commands, tasks finished through the transition and handoff commands. The only
// seeded rows are a verified or rejected verdict and its bundle, which a real evaluator run would leave (as finishTask does).

export interface AutonomyWorld {
  readonly w: TestWorld;
  readonly clock: { now: number };
  /** Moves the clock on so that the next record is strictly later than everything before it. */
  readonly tick: (ms?: number) => void;
  readonly digests: { next: number };
}

const worlds: Array<{ w: TestWorld; dir: string }> = [];
export const closeAutonomyWorlds = (): void => { for (const { w, dir } of worlds.splice(0)) { w.brain.close(); rmSync(dir, { recursive: true, force: true }); } };

export function autonomyWorld(): AutonomyWorld {
  const clock = { now: Date.now() };
  const dir = mkdtempSync(join(tmpdir(), "brain-test-autonomy-"));
  const w = setupWorld(new Brain({ dataDir: dir, allowTestActor: true, clock: { nowMs: () => clock.now, monotonicMs: () => clock.now } }));
  worlds.push({ w, dir });
  const bundle = fixtureStarter();
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  return { w, clock, tick: (ms = 1000) => { clock.now += ms; }, digests: { next: 0 } };
}

/**
 * The same helpers over a Governor that is already running on the system clock (the browser specs'), whose people and release exist.
 * Its clock cannot be moved, so records made in a row may share a millisecond: use it only where nothing needs ordering.
 */
export function autonomyContext(brain: Brain, organizationId: string, owner: TestWorld["owner"], workspaceId: string): AutonomyWorld {
  return { w: { brain, org: organizationId, owner, workspaceId } as unknown as TestWorld, clock: { now: Date.now() }, tick: () => undefined, digests: { next: 0 } };
}

/** A mission of `count` tasks, all finished: what a mission with a clean record looks like. */
export async function cleanMission(ctx: AutonomyWorld, key: string, count: number, options: { autonomy?: string; title?: string } = {}): Promise<string> {
  const id = await missionWithTasks(ctx, key, count, options);
  await finishTasks(ctx, id, tasksOf(1, count));
  return id;
}

/** Missions started from a Play, each with its proposed plan confirmed and every task finished, until at least `tasks` tasks are done. Returns their ids. */
export async function cleanPlayMissions(ctx: AutonomyWorld, key: string, playId: string, tasks: number): Promise<string[]> {
  const ids: string[] = [];
  for (let done = 0, n = 0; done < tasks && n < 6; n++) {
    const id = (await run(ctx, "mission.create", `${key}-${n}`, { title: `${key} ${n + 1}`, playId, autoStart: false })).resourceId ?? "";
    const planId = (ctx.w.brain.store.workspaceDb(ctx.w.workspaceId, ctx.w.org).prepare("SELECT id FROM plan_versions WHERE mission_id=?").get(id) as { id: string }).id;
    await run(ctx, "plan.confirm", `${key}-${n}-confirm`, { planVersionId: planId }, (await missionOf(ctx, id)).version);
    const planned = (await workView(ctx.w)).items.filter((entry) => entry.missionId === id && entry.state !== "abandoned").map((entry) => entry.planTaskId);
    await finishTasks(ctx, id, planned);
    done += planned.length;
    ids.push(id);
  }
  return ids;
}

export const run = async (ctx: AutonomyWorld, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> =>
  command(ctx.w, ctx.w.owner, commandType, key, payload, expectedVersion);

export const read = async <T>(ctx: AutonomyWorld, queryType: string, resourceId?: string): Promise<T> =>
  ((await ctx.w.brain.executeQuery(ctx.w.owner, { queryType, workspaceId: ctx.w.workspaceId, ...(resourceId ? { resourceId } : {}) } as never)) as unknown as { snapshot: T }).snapshot;

export const missionOf = (ctx: AutonomyWorld, id: string) => read<Mission>(ctx, "missions.get", id);
export const suggestions = (ctx: AutonomyWorld, resourceId?: string) => read<AutonomySuggestions>(ctx, "autonomy.suggestions", resourceId);
export const suggestionFor = async (ctx: AutonomyWorld, kind: string, subjectId: string): Promise<AutonomySuggestion | undefined> =>
  (await suggestions(ctx, `${kind}:${subjectId}`)).items[0];

/** A mission with `count` independent one-task plan entries (t1, t2, ...), confirmed and not auto-started. */
export async function missionWithTasks(ctx: AutonomyWorld, key: string, count: number, options: { autonomy?: string; title?: string } = {}): Promise<string> {
  const id = (await run(ctx, "mission.create", `${key}-create`, { title: options.title ?? `Mission ${key}`, intent: `Deliver ${key}`, successCriteria: ["delivered"], autoStart: false, ...(options.autonomy ? { autonomy: options.autonomy } : {}) })).resourceId ?? "";
  const tasks: PlanTask[] = Array.from({ length: count }, (_unused, index) => ({ id: `t${index + 1}`, title: `Task ${index + 1} of ${key}`, criteria: [`t${index + 1} is done`], dependsOn: [] }));
  const planId = (await run(ctx, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks })).resourceId ?? "";
  await run(ctx, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await missionOf(ctx, id)).version);
  return id;
}

/** Finishes the named tasks of a mission, one second apart, each on its own verified evidence. */
export async function finishTasks(ctx: AutonomyWorld, missionId: string, taskIds: readonly string[]): Promise<void> {
  for (const taskId of taskIds) {
    ctx.tick();
    await finishTask(ctx.w, missionId, taskId, (ctx.digests.next++ + 16).toString(16));
  }
  ctx.tick();
}
export const tasksOf = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_unused, index) => `t${from + index}`);

/** Sends a started task back from review with a finding, the way a reviewer does: that saves an eval case (ADR 0010). */
export async function sendBack(ctx: AutonomyWorld, missionId: string, taskId: string, finding: string): Promise<void> {
  const current = async (): Promise<WorkItem> => (await workView(ctx.w)).items.find((entry) => entry.missionId === missionId && entry.planTaskId === taskId)!;
  for (const state of ["in-progress", "review", "in-progress"]) {
    const item = await current();
    await run(ctx, "workItem.transition", `${missionId}-${taskId}-${state}-${item.version}`, { workItemId: item.workItemId, state, ...(state === "in-progress" ? { reason: finding } : {}) }, item.version);
    ctx.tick(10);
  }
  ctx.tick();
}

/** What a real evaluator run leaves for a result an independent check judged not verified, linked to the task's own run. */
export function judgeRejected(ctx: AutonomyWorld, workItemId: string, key: string): void {
  const ws = ctx.w.brain.store.workspaceDb(ctx.w.workspaceId, ctx.w.org);
  const digest = `sha256:${key.padEnd(64, "0")}`;
  const now = ctx.w.brain.store.now();
  ws.prepare("INSERT INTO evidence_bundles(digest, bundle_id, job_id, attempt_id, state, manifest_json, created_at_ms) VALUES (?,?,?,?, 'verified', '{}', ?)").run(digest, `bundle-${key}`, `job-${key}`, "att-rejected", now);
  ws.prepare("INSERT INTO verification_verdicts(id, bundle_digest, evaluator_attempt_id, evaluator_digest, outcome, manifest_json, created_at_ms, finalized_at_ms) VALUES (?,?,?,?, 'rejected', '{}', ?, ?)").run(`verdict-${key}`, digest, `eval-${key}`, `sha256:${"a".repeat(64)}`, now, now);
  // A further link of the same task, with a run of its own, so the task's finished run keeps its own bundle.
  ws.prepare("INSERT INTO execution_links(mission_id,work_item_id,run_id,job_id,created_at_ms) SELECT mission_id,id,?,?,? FROM work_items WHERE id=?").run(`run-${key}`, `job-${key}`, now, workItemId);
}
