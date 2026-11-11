import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, JsonValue, Mission, PlanTask, WorkItem } from "@brain/contracts";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

type World = ReturnType<typeof setupWorld>;
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.brain.close(); });

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const db = (w: World) => w.brain.store.workspaceDb(w.workspaceId, w.org);
const item = (w: World, missionId: string, taskId: string) => {
  const row = db(w).prepare("SELECT id FROM work_items WHERE mission_id=? AND plan_task_id=?").get(missionId, taskId) as { id: string };
  return w.brain.missions.query(w.owner, "workItems.get", w.workspaceId, row.id) as unknown as WorkItem;
};
const runsOf = (w: World, workItemId: string) => (db(w).prepare("SELECT run_id FROM execution_links WHERE work_item_id=?").all(workItemId) as Array<{ run_id: string }>).map((row) => row.run_id);
const until = async (done: () => boolean) => {
  const deadline = Date.now() + 15_000;
  while (!done()) { if (Date.now() > deadline) throw new Error("did not progress"); await new Promise((resolve) => setTimeout(resolve, 25)); }
};

/** The starter release plus the general task workflow without its evaluator step, so a test finishes a task's run by itself. */
function world(): World {
  const w = setupWorld();
  const bundle = fixtureStarter();
  const source = bundle.documents.find((doc) => doc.path.endsWith("general-task.yaml"))!;
  const workflow = JSON.parse(source.text);
  workflow.metadata.id = "general-single";
  delete workflow.spec.jobs["validate"];
  workflow.spec.outputs["passed"] = { source: "literal", value: true };
  bundle.documents.push({ path: "config/general-single.yaml", text: JSON.stringify(workflow, null, 2) + "\n" });
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  worlds.push(w);
  return w;
}

const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id} is written up`], dependsOn: [], workflowId: "general-single", ...extra });
const report = (title: string, body: string) => ({
  summary: `Findings of ${title}.`,
  deliverable: `# ${title}\n\n${body}\n\n${"The analysis compares the options on cost and effort and recommends one for the stated reasons. ".repeat(3)}`,
  criteria: [{ criterion: `${title} is written up`, met: true, evidence: "The findings section covers this point in detail." }],
  assumptions: ["Prices exclude tax"],
});
async function finish(w: World, runId: string, output: unknown): Promise<void> {
  await until(() => Boolean(w.brain.store.control.prepare("SELECT 1 FROM jobs WHERE workflow_run_id=? AND step_id='respond'").get(runId)));
  w.brain.workflows.completeStep(w.org, w.workspaceId, runId, "respond", output as JsonValue, true);
  await until(() => (db(w).prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId) as { state: string }).state === "succeeded");
}

/** A confirmed two-task mission whose plan a schedule can repeat. */
async function sourceMission(w: World): Promise<string> {
  const id = (await run(w, "mission.create", "src-create", { title: "Weekly report", intent: "Write the weekly report", successCriteria: ["delivered"] })).resourceId ?? "";
  const planId = (await run(w, "plan.propose", "src-plan", { missionId: id, origin: "manual", tasks: [task("gather"), task("write")] })).resourceId ?? "";
  const version = ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot.version;
  await run(w, "plan.confirm", "src-confirm", { planVersionId: planId }, version);
  // "Repeat this" is offered on a finished mission: its work is verified and it is closed as achieved.
  db(w).prepare("INSERT INTO mission_evidence_bundles(digest,mission_id,state,manifest_json,findings_json,created_at_ms) VALUES (?,?,'verified','{}','[]',?)").run(`sha256:${"7".repeat(64)}`, id, Date.now());
  db(w).prepare("UPDATE missions SET state='closed', outcome='achieved' WHERE id=?").run(id);
  return id;
}

const upsert = (w: World, input: Record<string, unknown>) => run(w, "automation.upsert", `auto-${Math.random()}`, {
  title: "Repeat: Weekly report", target: { kind: "workflow", id: "general-task" }, trigger: { kind: "cron", cron: "0 8 * * *", timezone: "UTC" }, overlap: "queue-one", ...input,
});
const runNow = async (w: World, automationId: string) => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return run(w, "automation.control", `now-${Math.random()}`, { automationId, action: "runNow" });
};
const occurrences = (w: World, automationId: string) => (w.brain.jobProtocol.automations.query(w.owner, "automations.occurrences", w.workspaceId, automationId) as unknown as { items: Array<{ occurrenceId: string; state: string; dispatchRef?: string; detail?: string }> }).items;
const diff = (w: World, ref: string) => w.brain.jobProtocol.automations.query(w.owner, "automations.diff", w.workspaceId, ref) as unknown as { kind: string; outputs: Array<{ name: string; status: string; added: number; removed: number }> };

describe("a repeated described mission is a real mission occurrence (rows 30 and 31)", () => {
  it("starts a mission with its own confirmed plan per occurrence, and compares results task by task", async () => {
    const w = world();
    const source = await sourceMission(w);
    const saved = await upsert(w, { input: { situation: "Write the weekly report\n\nDone when:\n- delivered", sourceMissionId: source } });
    const automationId = saved.resourceId ?? "";

    await runNow(w, automationId);
    const first = occurrences(w, automationId).find((entry) => entry.state === "dispatched")!;
    expect(first.dispatchRef).toMatch(/^mission-/u);
    const m1 = first.dispatchRef!;
    // The occurrence is a mission: confirmed plan with the source's task ids, the described intent and criteria, started by the schedule.
    const brief = db(w).prepare("SELECT title, intent, success_criteria_json, state, started_by_occurrence AS occ FROM missions WHERE id=?").get(m1) as { title: string; intent: string; success_criteria_json: string; state: string; occ: string };
    expect(brief).toMatchObject({ intent: "Write the weekly report", state: "active", occ: first.occurrenceId });
    expect(brief.title.startsWith("Weekly report · ")).toBe(true);
    expect(JSON.parse(brief.success_criteria_json)).toEqual(["delivered"]);
    expect((db(w).prepare("SELECT plan_task_id FROM work_items WHERE mission_id=? ORDER BY plan_task_id").all(m1) as Array<{ plan_task_id: string }>).map((row) => row.plan_task_id)).toEqual(["gather", "write"]);
    // No bare workflow run was started for the occurrence itself.
    expect(db(w).prepare("SELECT 1 FROM workflow_runs WHERE execution_key=?").get(first.occurrenceId)).toBeUndefined();

    await w.brain.autoStart.sweep(w.org, w.workspaceId);
    await finish(w, runsOf(w, item(w, m1, "gather").workItemId)[0]!, report("Gather", "alpha findings"));
    await w.brain.autoStart.sweep(w.org, w.workspaceId);
    await finish(w, runsOf(w, item(w, m1, "write").workItemId)[0]!, report("Write", "beta findings"));
    // Each task's written result is a version of an output named by the task id: the same names in every occurrence.
    const names = (db(w).prepare("SELECT name FROM mission_outputs WHERE mission_id=? ORDER BY name").all(m1) as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(["gather", "write"]);

    await runNow(w, automationId);
    const second = occurrences(w, automationId).filter((entry) => entry.state === "dispatched").find((entry) => entry.dispatchRef !== m1)!;
    const m2 = second.dispatchRef!;
    expect(m2).not.toBe(m1);
    expect(diff(w, second.occurrenceId).kind).toBe("previous-pending");
    await w.brain.autoStart.sweep(w.org, w.workspaceId);
    await finish(w, runsOf(w, item(w, m2, "gather").workItemId)[0]!, report("Gather", "alpha findings"));
    await w.brain.autoStart.sweep(w.org, w.workspaceId);
    await finish(w, runsOf(w, item(w, m2, "write").workItemId)[0]!, report("Write", "gamma findings"));
    const change = diff(w, second.occurrenceId);
    expect(change.kind).toBe("changed");
    expect(change.outputs.map((output) => [output.name, output.status])).toEqual([["gather", "unchanged"], ["write", "changed"]]);
    // The mission ref resolves the same comparison, so the mission page shows what changed.
    expect(diff(w, m2).kind).toBe("changed");
  });

  it("is idempotent per occurrence and honours the skip overlap policy through the mission being open", async () => {
    const w = world();
    const saved = await upsert(w, { overlap: "skip", input: { situation: "Summarise the week\n\nDone when:\n- the summary is written\n- it states its assumptions" } });
    const automationId = saved.resourceId ?? "";
    await runNow(w, automationId);
    const first = occurrences(w, automationId).find((entry) => entry.state === "dispatched")!;
    // Without a named source the described work is one task called "result" with the described criteria, and a person confirms it (ADR 0017).
    const planned = JSON.parse((db(w).prepare("SELECT tasks_json, state FROM plan_versions WHERE mission_id=?").get(first.dispatchRef!) as { tasks_json: string; state: string }).tasks_json) as Array<{ id: string; criteria: string[] }>;
    expect(planned.map((row) => row.id)).toEqual(["result"]);
    expect(planned[0]!.criteria).toEqual(["the summary is written", "it states its assumptions"]);
    expect((db(w).prepare("SELECT state FROM plan_versions WHERE mission_id=?").get(first.dispatchRef!) as { state: string }).state).toBe("proposed");
    expect(w.brain.missions.startFromDescription({ organizationId: w.org, workspaceId: w.workspaceId, title: "again", situation: "x", startedBy: "owner-1", occurrenceId: first.occurrenceId })).toBe(first.dispatchRef);
    // The first mission is still open, so the next occurrence is skipped rather than piled on.
    await runNow(w, automationId);
    const skipped = occurrences(w, automationId).filter((entry) => entry.state === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.detail).toMatch(/still running/u);
    expect((db(w).prepare("SELECT COUNT(*) AS n FROM missions").get() as { n: number }).n).toBe(1);
  });
});
