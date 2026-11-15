import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, Mission, PlanTask, WorkItem } from "@brain/contracts";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { command as cmd } from "../support/reuse";

// ADR 0062 at the Governor's command/query boundary: each choice (the way of working a task was started on, the team member it was given to)
// writes its reason when it is made; the run's explanation reads those rows and never recomputes them; a later decision adds a row, and a
// choice nobody made leaves no row. State is reached through commands only. (The model-route reasons are covered with the routes, in model-routes.test.ts.)
type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

function world(starter = true): World {
  const w = setupWorld();
  if (starter) {
    const bundle = fixtureStarter();
    w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  }
  worlds.push(w);
  return w;
}
const ws = (w: World) => w.brain.store.workspaceDb(w.workspaceId, w.org);
const run = (w: World, type: string, key: string, payload: Record<string, unknown>, version?: number): Promise<CommandReceipt> => cmd(w, w.owner, type, key, payload, version);
const mission = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;
const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [], ...extra });
const item = (w: World, missionId: string, taskId: string): WorkItem => {
  const id = (ws(w).prepare("SELECT id FROM work_items WHERE mission_id=? AND plan_task_id=? AND state!='abandoned'").get(missionId, taskId) as { id: string }).id;
  return w.brain.missions.query(w.owner, "workItems.get", w.workspaceId, id) as unknown as WorkItem;
};
const runOf = (w: World, workItemId: string): string => (ws(w).prepare("SELECT run_id FROM execution_links WHERE work_item_id=? ORDER BY created_at_ms DESC LIMIT 1").get(workItemId) as { run_id: string }).run_id;
interface Choice { kind: string; code: string; facts: Record<string, unknown>; recordedAt: string }
const explain = async (w: World, resourceId: string): Promise<{ primaryReason: string; choices: Choice[] }> =>
  ((await w.brain.executeQuery(w.owner, { queryType: "job.explain", workspaceId: w.workspaceId, resourceId } as never)) as unknown as { snapshot: { primaryReason: string; choices: Choice[] } }).snapshot;
const choicesOf = async (w: World, runId: string, kind: string) => (await explain(w, runId)).choices.filter((choice) => choice.kind === kind);

async function start(w: World, key: string, tasks: PlanTask[], extra: Record<string, unknown> = {}): Promise<string> {
  const { team: _team, ...create } = extra;
  const id = (await run(w, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], ...create })).resourceId ?? "";
  const planId = (await run(w, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", tasks, ...(extra["team"] ? { team: extra["team"] } : {}) })).resourceId ?? "";
  await run(w, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await mission(w, id)).version);
  return id;
}
const SRE_TOOLS = ["host.exec", "host.read"];

describe("the way of working a task was started on records its reason", () => {
  it("names the workflow, where it came from and every workflow ruled out with why, and keeps saying so after the world changes", async () => {
    const w = world();
    await run(w, "workspace.wayOfWorking.set", "wow", { workflowId: "sre-task", requiredTools: SRE_TOOLS });
    const id = await start(w, "wow", [task("a")]);
    const runId = runOf(w, item(w, id, "a").workItemId);
    const [chosen, ...rest] = await choicesOf(w, runId, "way-of-working");
    expect(rest).toEqual([]);
    expect(chosen).toMatchObject({ code: "workspace-way-of-working", facts: { workflowId: "sre-task", requiredTools: SRE_TOOLS } });
    // The general task workflow was weighed first and ruled out: it lacks the tools the task must observe.
    expect(chosen!.facts["rejected"]).toContainEqual({ workflowId: "general-task", why: "missing-tool", missingTools: SRE_TOOLS });

    // The workspace changes its way of working afterwards: the reason written then does not move.
    const before = JSON.stringify(await choicesOf(w, runId, "way-of-working"));
    await run(w, "workspace.wayOfWorking.set", "wow-2", { workflowId: "general-task", requiredTools: [] });
    expect(JSON.stringify(await choicesOf(w, runId, "way-of-working"))).toBe(before);

    // A task that names its own workflow says so.
    const own = await start(w, "own", [task("a", { workflowId: "general-task" })]);
    expect(await choicesOf(w, runOf(w, item(w, own, "a").workItemId), "way-of-working")).toMatchObject([{ code: "task-workflow", facts: { workflowId: "general-task" } }]);
  });

  it("is immutable, and a restarted task adds a row for the new run instead of rewriting the first", async () => {
    const w = world();
    await run(w, "workspace.wayOfWorking.set", "wow-i", { workflowId: "sre-task", requiredTools: SRE_TOOLS });
    const id = await start(w, "imm", [task("a")]);
    const first = runOf(w, item(w, id, "a").workItemId);
    expect(() => w.brain.store.control.prepare("UPDATE choice_reasons SET code='other'").run()).toThrow(/never rewritten/);
    const count = () => (w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM choice_reasons WHERE kind='way-of-working'").get() as { n: number }).n;
    expect(count()).toBe(1);
    // Starting the task again (a fresh run, a fresh command id) is a new decision: it adds a row and leaves the first alone.
    ws(w).prepare("UPDATE work_items SET failed_attempts=1, state='ready', parked=0 WHERE id=?").run(item(w, id, "a").workItemId);
    await w.brain.autoStart.sweepAll();
    expect(count()).toBe(2);
    expect((await choicesOf(w, first, "way-of-working"))).toHaveLength(1);
  });

  it("leaves no reason when a person started the run themselves", async () => {
    const w = world(false);
    await w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-manual", commandType: "workflow.dispatch", workspaceId: w.workspaceId, idempotencyKey: "manual",
      payload: { workflow: { id: "fixture-workflow", digest: w.brain.activeRelease(w.org)!.digest }, input: { message: "by hand" } },
    } as never, "manual");
    const runId = (ws(w).prepare("SELECT id FROM workflow_runs LIMIT 1").get() as { id: string }).id;
    const view = await explain(w, runId);
    expect(view.choices).toEqual([]);
    expect(view.primaryReason).toBeTruthy();
  });
});

describe("the team member a task was given to records the facts it was judged by", () => {
  const team = [
    { memberId: "researcher", role: "Researcher", agentId: "task-worker", engine: "fixture" },
    { memberId: "writer", role: "Writer", agentId: "task-worker", engine: "fixture" },
  ];
  it("names the member, its agent and engine, what the task needed and who else would have fit", async () => {
    const w = world();
    const id = await start(w, "team", [task("a", { workflowId: "general-task", assignment: { kind: "agent", id: "researcher", role: "specialist" } }), task("b", { workflowId: "general-task" })], { team });
    const [reason] = await choicesOf(w, runOf(w, item(w, id, "a").workItemId), "team-member");
    expect(reason).toMatchObject({ code: "member-eligible", facts: { taskId: "a", memberId: "researcher", role: "Researcher", agentId: "task-worker", engine: "fixture", requiredTools: [], alsoEligible: ["writer"] } });
    // A task nobody assigned has no member choice behind it.
    expect(await choicesOf(w, runOf(w, item(w, id, "b").workItemId), "team-member")).toEqual([]);
  });

  it("does not rewrite the reason when the task is reassigned: the new work item gets its own", async () => {
    const w = world();
    const id = await start(w, "reassign", [task("a", { workflowId: "general-task", assignment: { kind: "agent", id: "researcher", role: "specialist" }, criteria: ["a-done"] })], { team, autoStart: false });
    const firstItem = item(w, id, "a").workItemId;
    const reasons = () => w.brain.store.control.prepare("SELECT subject_id, facts_json FROM choice_reasons WHERE kind='team-member' ORDER BY id").all() as Array<{ subject_id: string; facts_json: string }>;
    expect(reasons()).toHaveLength(1);
    const next = (await run(w, "plan.propose", "reassign-2", { missionId: id, origin: "manual", team, tasks: [task("a", { workflowId: "general-task", assignment: { kind: "agent", id: "writer", role: "specialist" } })] })).resourceId ?? "";
    await run(w, "plan.confirm", "reassign-2-confirm", { planVersionId: next }, (await mission(w, id)).version);
    const all = reasons();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ subject_id: firstItem });
    expect(JSON.parse(all[0]!.facts_json)).toMatchObject({ memberId: "researcher" });
    expect(JSON.parse(all[1]!.facts_json)).toMatchObject({ memberId: "writer" });
  });
});
