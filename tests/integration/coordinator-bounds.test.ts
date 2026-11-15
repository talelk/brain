import { afterEach, describe, expect, it } from "vitest";
import type { Mission, PlanTask, PlanVersion, TeamMember } from "@brain/contracts";
import { bearer, closeWorlds, command, freshWorld, missionOf, run, running, type World } from "../support/machine-session";

// ADR 0045: a coordinator plans and only plans. Its session credential is the one the runner obtains for its attempt; the Governor's command
// funnel decides. These tests drive that boundary with the starter Play "Research and write, planned by a coordinator".

afterEach(closeWorlds);

const PLAY = "research-with-coordinator";
const budget = { maxMicroUsd: 2_000_000, memberCap: 3, attemptReserveMicroUsd: 0, finalAllowanceMicroUsd: 200_000 };

const query = async <T>(w: World, queryType: string, resourceId?: string): Promise<T> => ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) } as never)) as unknown as { snapshot: T }).snapshot;
const planRows = (w: World, missionId: string) => w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id, revision, state, origin, created_by, tasks_json, team_json FROM plan_versions WHERE mission_id=? ORDER BY revision").all(missionId) as
  Array<{ id: string; revision: number; state: string; origin: string; created_by: string; tasks_json: string; team_json: string }>;
const until = async (done: () => boolean): Promise<void> => { const deadline = Date.now() + 15_000; while (!done()) { if (Date.now() > deadline) throw new Error("the Governor did not get there"); await new Promise((resolve) => setTimeout(resolve, 20)); } };

/** A mission from the Play, its starting plan confirmed by the person, and the coordinator's attempt running with its session credential. */
async function wokenCoordinator(options: { autonomy?: "supervised" | "standard" | "autonomous"; autoStart?: boolean; budget?: typeof budget } = {}) {
  const { w, runner } = freshWorld();
  const missionId = (await run(w, "mission.create", "play-create", { title: "Research the offsite venues", playId: PLAY, autoStart: options.autoStart ?? false, ...(options.autonomy ? { autonomy: options.autonomy } : {}), ...(options.budget ? { budget: options.budget } : {}) })).resourceId ?? "";
  const startingPlanId = planRows(w, missionId)[0]!.id;
  await run(w, "plan.confirm", "play-confirm", { planVersionId: startingPlanId }, (await missionOf(w, missionId)).version);
  expect(w.brain.missions.pumpCoordinators()).toBe(1);
  const coordinatorRun = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT run_id AS runId FROM mission_runs WHERE mission_id=?").get(missionId) as { runId: string }).runId;
  await until(() => Boolean(w.brain.store.control.prepare("SELECT 1 FROM jobs WHERE workflow_run_id=? AND step_id='plan'").get(coordinatorRun)));
  const offer = running(w, runner, "coordinator");
  const grant = w.brain.jobProtocol.sessionCredential(runner, offer.attemptId);
  const identity = await w.brain.resolveActor(bearer(grant.credential), w.workspaceId);
  const act = (commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) =>
    w.brain.executeCommand(identity.actor, { ...(command(w, commandType, key, payload) as object), ...(expectedVersion ? { expectedVersion } : {}) } as never, key);
  return { w, runner, missionId, startingPlanId, coordinatorRun, grant, actor: identity.actor, act };
}
const tasksOf = (w: World, planId: string): PlanTask[] => JSON.parse((w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT tasks_json FROM plan_versions WHERE id=?").get(planId) as { tasks_json: string }).tasks_json) as PlanTask[];
const withCheck = (tasks: PlanTask[]): PlanTask[] => [...tasks, { id: "check-sources", title: "Check each claim in the brief against its source", criteria: ["Every claim has a source"], dependsOn: ["write"], assignment: { kind: "agent", id: "researcher", role: "specialist" } }];

describe("a coordinator's session", () => {
  it("is the coordinator member's own principal, bound to its mission, with no work item", async () => {
    const { w, missionId, grant, actor } = await wokenCoordinator();
    expect(grant).toMatchObject({ missionId, memberId: "lead", principalId: `agent:${missionId}:lead` });
    expect(grant.workItemId).toBeUndefined();
    expect(actor).toMatchObject({ kind: "agent", actorId: `agent:${missionId}:lead`, delegatedBy: w.owner.actorId, memberId: "lead" });
  });

  it("confirms a plan version inside the autonomy policy and leaves one outside it waiting for a person, who alone confirms it", async () => {
    const { w, missionId, startingPlanId, act } = await wokenCoordinator();
    const starting = tasksOf(w, startingPlanId);
    const inside = (await act("plan.propose", "inside", { missionId, origin: "agent", summary: "Add a source check", tasks: withCheck(starting) })).receipt.resourceId!;
    expect(await query<PlanVersion>(w, "plans.get", inside)).toMatchObject({ state: "confirmed", origin: "agent" });
    expect((await missionOf(w, missionId)).activePlanVersionId).toBe(inside);

    // A new role needs more than the standard policy allows: it is a proposal for a person.
    const auditor: TeamMember = { memberId: "auditor", role: "Auditor", agentId: "task-worker", engine: "fixture" };
    const team = JSON.parse(planRows(w, missionId).at(-1)!.team_json) as TeamMember[];
    const beyond = (await act("plan.propose", "beyond", { missionId, origin: "agent", summary: "Add an auditor", tasks: withCheck(starting), team: [...team, auditor] })).receipt.resourceId!;
    expect(await query<PlanVersion>(w, "plans.get", beyond)).toMatchObject({ state: "proposed" });
    expect((await missionOf(w, missionId)).activePlanVersionId).toBe(inside);
    await expect(act("plan.confirm", "self-confirm", { planVersionId: beyond }, (await missionOf(w, missionId)).version)).rejects.toThrow(/cannot run plan\.confirm/u);
    expect((await missionOf(w, missionId)).activePlanVersionId).toBe(inside);

    await run(w, "plan.confirm", "person-confirm", { planVersionId: beyond }, (await missionOf(w, missionId)).version);
    expect(await query<PlanVersion>(w, "plans.get", beyond)).toMatchObject({ state: "confirmed", team: [...team, auditor] });
  });

  it("proposes under a supervised mission and every version waits for a person", async () => {
    const { w, missionId, startingPlanId, act } = await wokenCoordinator({ autonomy: "supervised" });
    const proposed = (await act("plan.propose", "supervised", { missionId, origin: "agent", summary: "Add a source check", tasks: withCheck(tasksOf(w, startingPlanId)) })).receipt.resourceId!;
    expect(await query<PlanVersion>(w, "plans.get", proposed)).toMatchObject({ state: "proposed" });
    expect((await missionOf(w, missionId)).activePlanVersionId).toBe(startingPlanId);
  });

  it("can neither judge, close, confirm, approve, widen its own policy nor start work: each command is refused and changes nothing", async () => {
    const { w, missionId, startingPlanId, act } = await wokenCoordinator();
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const proposal = (await act("plan.propose", "pending", { missionId, origin: "agent", tasks: withCheck(tasksOf(w, startingPlanId)), team: [...(JSON.parse(planRows(w, missionId)[0]!.team_json) as TeamMember[]), { memberId: "auditor", role: "Auditor", agentId: "task-worker", engine: "fixture" }] })).receipt.resourceId!;
    const gather = (db.prepare("SELECT id FROM work_items WHERE mission_id=? AND plan_task_id='gather' AND state!='abandoned'").get(missionId) as { id: string }).id;
    const digest = `sha256:${"a".repeat(64)}`;
    const snapshot = async () => ({ mission: await missionOf(w, missionId), items: db.prepare("SELECT id, state, version FROM work_items ORDER BY id").all(), plans: planRows(w, missionId).map((row) => [row.id, row.state]), runs: db.prepare("SELECT COUNT(*) AS n FROM workflow_runs").get() });
    const before = await snapshot();
    const version = (await missionOf(w, missionId)).version;
    const refused: Array<[string, Record<string, unknown>, number?]> = [
      ["mission.verdict.record", { missionId, bundleDigest: digest, outcome: "verified" }],
      ["mission.close", { missionId, outcome: "achieved" }, version],
      ["mission.proposeCompletion", { missionId }, version],
      ["mission.pause", { missionId }, version],
      ["plan.confirm", { planVersionId: proposal }, version],
      ["plan.reject", { planVersionId: proposal, reason: "No" }],
      ["mission.policy.set", { missionId, preset: "autonomous" }, version],
      ["mission.budget.set", { missionId, budget: { maxMicroUsd: 999_999_999, memberCap: 3 } }, version],
      ["mission.brief.edit", { missionId, baseVersion: 1, intent: "Something else" }],
      ["workItem.transition", { workItemId: gather, state: "done", evidenceDigest: digest }, 1],
      ["workflow.dispatch", { workflow: { id: "general-task", digest }, input: { situation: "Do it" } }],
      // It cannot wake itself by messaging the mission, and cannot interrupt a session.
      ["mission.message.send", { missionId, recipient: { kind: "mission" }, body: "Wake me again" }],
    ];
    for (const [type, payload, expected] of refused) await expect(act(type, `refused-${type}`, payload, expected), type).rejects.toThrow(/cannot run|missing scope|human|forbidden|not the mission/iu);
    expect(await snapshot()).toEqual(before);
    // What its tools do reach still works: a message to another member is recorded and the mission state is untouched.
    expect((await act("mission.message.send", "to-member", { missionId, recipient: { kind: "member", memberId: "researcher" }, body: "Start with the 2025 figures" })).receipt.accepted).toBe(true);
    expect((await missionOf(w, missionId)).state).toBe("active");
  });

  it("spends the final allowance only as the coordinator: ordinary work is refused where the coordinator's run is admitted", async () => {
    const { w, runner } = freshWorld();
    void runner;
    const missionId = (await run(w, "mission.create", "allowance-create", { title: "Research the offsite venues", playId: PLAY, budget: { maxMicroUsd: 100, memberCap: 3, attemptReserveMicroUsd: 50, finalAllowanceMicroUsd: 50 } })).resourceId ?? "";
    await run(w, "plan.confirm", "allowance-confirm", { planVersionId: planRows(w, missionId)[0]!.id }, (await missionOf(w, missionId)).version);
    expect(w.brain.missions.pumpCoordinators()).toBe(1);
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const coordinatorRun = (db.prepare("SELECT run_id AS runId FROM mission_runs WHERE mission_id=?").get(missionId) as { runId: string }).runId;
    // The Governor starts the ready task (the coordinator plans only); its attempt reserves what the ordinary ceiling leaves.
    await until(() => Boolean(db.prepare("SELECT 1 FROM execution_links l JOIN work_items i ON i.id=l.work_item_id WHERE i.mission_id=?").get(missionId)));
    const workRun = (db.prepare("SELECT l.run_id AS runId FROM execution_links l JOIN work_items i ON i.id=l.work_item_id WHERE i.mission_id=? ORDER BY l.created_at_ms LIMIT 1").get(missionId) as { runId: string }).runId;
    expect(w.brain.missions.admission(w.org, w.workspaceId, workRun)).toMatchObject({ admitted: true, reserve: 50 });
    w.brain.missions.recordReservation(w.org, w.workspaceId, { missionId, runId: workRun, attemptId: "att-work-1", microUsd: 50 });
    expect(w.brain.missions.admission(w.org, w.workspaceId, workRun)).toMatchObject({ admitted: false, reason: "budget" });
    const coordinator = w.brain.missions.admission(w.org, w.workspaceId, coordinatorRun);
    expect(coordinator, JSON.stringify(coordinator)).toMatchObject({ admitted: true, reserve: 50 });
  });
});

describe("a mission started from a Play without a coordinator", () => {
  it("has no coordinator to wake: its events record no wake and no coordinator run starts", async () => {
    const { w } = freshWorld();
    const id = (await run(w, "mission.create", "plain", { title: "Plain research", playId: "research-and-write", autoStart: false })).resourceId ?? "";
    await run(w, "plan.confirm", "plain-confirm", { planVersionId: planRows(w, id)[0]!.id }, (await missionOf(w, id)).version);
    expect((await query<Mission>(w, "missions.get", id)).coordinatorMemberId).toBeUndefined();
    expect(w.brain.missions.pumpCoordinators()).toBe(0);
    expect((w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT COUNT(*) AS n FROM mission_wakes").get() as { n: number }).n).toBe(0);
  });
});
