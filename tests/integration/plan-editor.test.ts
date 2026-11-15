import { describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, Mission, PlanTask, PlanVersion, TeamMember, WorkItem } from "@brain/contracts";
import { goldenDocs, setupWorld, workView } from "../helpers";

type World = ReturnType<typeof setupWorld>;

async function run(w: World, actor: ActorContext, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const fails = async (fn: () => Promise<unknown>, pattern: RegExp) => await expect(Promise.resolve().then(fn)).rejects.toThrow(pattern);
const mission = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: Mission }).snapshot;
const plan = async (w: World, id: string) => ((await w.brain.executeQuery(w.owner, { queryType: "plans.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: PlanVersion }).snapshot;
const task = (id: string, member: string | undefined, extra: Partial<PlanTask> = {}): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [], ...(member ? { assignment: { kind: "agent", id: member, role: "specialist" } } : {}), ...extra });
const member = (memberId: string, agentId: string, role = "Engineer", engine = "pi"): TeamMember => ({ memberId, role, agentId, engine });
const agent = (id: string, spec: { tools?: string[]; engines?: string[]; maxMicroUsd?: number }) => {
  const tools = spec.tools?.length ? `  tools:\n${spec.tools.map((tool) => `    - id: ${tool}\n      digest: ${ECHO_DIGEST}\n`).join("")}` : "  tools: []\n";
  return {
    path: `config/${id}.yaml`,
    text: `apiVersion: brain.keyrus/v1\nkind: Agent\nmetadata:\n  id: ${id}\n  version: 1.0.0\nspec:\n  instructionsPath: agents/${id}.md\n${tools}`
      + `  engine:\n    anyOf: [${(spec.engines ?? ["pi"]).join(", ")}]\n    features: [start, events, cancel]\n  maxTurns: 5\n  maxChildren: 0\n  maxDepth: 0\n  maxTokens: 1000\n  maxMicroUsd: ${spec.maxMicroUsd ?? 0}\n`,
  };
};
const instructions = (id: string) => ({ agentId: id, path: `agents/${id}.md`, text: `# ${id}\n` });
const ECHO_DIGEST = "sha256:a3fe6a4caae9923fc7b88b98a9bb83234540741512decc87707dd2e97e03d6f0";
const REVISION = "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4";

/** A workspace whose release holds a builder (has fixture.echo, no spend cap), a reviewer (no tools, capped) and a claude-only analyst. */
function withAgents(): World {
  const w = setupWorld();
  const release = w.brain.stageRelease(w.owner, [...goldenDocs(), agent("builder", { tools: ["fixture.echo"] }), agent("reviewer", { maxMicroUsd: 100 }), agent("analyst", { tools: ["fixture.echo"], engines: ["claude"] })],
    REVISION, [], [instructions("builder"), instructions("reviewer"), instructions("analyst")]);
  w.brain.activateRelease(w.owner, release.digest);
  return w;
}

const TEAM = [member("backend", "builder", "Backend engineer"), member("qa", "reviewer", "Reviewer")];

/** A confirmed plan with two independent tasks: a (backend) and b (qa). */
async function confirmed(w: World, key: string, autonomy?: string): Promise<{ id: string; planId: string }> {
  const id = (await run(w, w.owner, "mission.create", `${key}-create`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], ...(autonomy ? { autonomy } : {}) })).resourceId ?? "";
  const planId = (await run(w, w.owner, "plan.propose", `${key}-plan`, { missionId: id, origin: "manual", team: TEAM, tasks: [task("a", "backend"), task("b", "qa")] })).resourceId ?? "";
  await run(w, w.owner, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await mission(w, id)).version);
  return { id, planId };
}
const items = async (w: World): Promise<WorkItem[]> => (await workView(w)).items.filter((item) => item.state !== "abandoned");

describe("the plan editor changes assignment and the mission team (#119)", () => {
  it("a person's reassignment and team change is a new plan version that applies plan and team together on confirm", async () => {
    const w = withAgents();
    const { id, planId } = await confirmed(w, "ed-new");
    const before = await items(w);
    const team = [...TEAM, member("backend-2", "builder", "Backend engineer")];
    const proposed = (await run(w, w.owner, "plan.propose", "ed-new-edit", { missionId: id, origin: "manual", summary: "Hand task a to a second engineer", team, tasks: [task("a", "backend-2"), task("b", "qa")] })).resourceId ?? "";
    const version = await plan(w, proposed);
    expect(version).toMatchObject({ state: "proposed", revision: 2, origin: "manual", team });
    expect(version.tasks.find((entry) => entry.id === "a")?.assignment).toEqual({ kind: "agent", id: "backend-2", role: "specialist" });
    // Nothing applies before confirmation: the confirmed version, its team and its work items are untouched.
    expect(await plan(w, planId)).toMatchObject({ state: "confirmed", team: TEAM });
    expect((await mission(w, id)).activePlanVersionId).toBe(planId);
    expect((await items(w)).map((item) => item.assignment)).toEqual(before.map((item) => item.assignment));

    await run(w, w.owner, "plan.confirm", "ed-new-confirm-2", { planVersionId: proposed }, (await mission(w, id)).version);
    expect((await plan(w, planId)).state).toBe("superseded");
    expect((await mission(w, id)).activePlanVersionId).toBe(proposed);
    const after = await items(w);
    expect(after.find((item) => item.planTaskId === "a")?.assignment).toEqual({ kind: "agent", id: "backend-2", role: "specialist" });
    // Work the edit did not touch is the same work item.
    expect(after.find((item) => item.planTaskId === "b")?.workItemId).toBe(before.find((item) => item.planTaskId === "b")?.workItemId);
    expect((await plan(w, proposed)).team).toEqual(team);
    w.brain.close();
  });

  it("confirming an edited proposal retires the proposal it was edited from, so it never comes back as the plan to confirm", async () => {
    const w = withAgents();
    const { id } = await confirmed(w, "ed-retire");
    const drafted = (await run(w, w.owner, "plan.propose", "ed-retire-draft", { missionId: id, origin: "manual", team: TEAM, tasks: [task("a", "backend"), task("b", "backend")] })).resourceId ?? "";
    const edited = (await run(w, w.owner, "plan.propose", "ed-retire-edit", { missionId: id, origin: "manual", team: TEAM, tasks: [task("a", "qa"), task("b", "backend")] })).resourceId ?? "";
    await run(w, w.owner, "plan.confirm", "ed-retire-go", { planVersionId: edited }, (await mission(w, id)).version);
    expect((await plan(w, drafted)).state).toBe("superseded");
    expect((await plan(w, edited)).state).toBe("confirmed");
    await fails(async () => await run(w, w.owner, "plan.confirm", "ed-retire-stale", { planVersionId: drafted }, (await mission(w, id)).version), /only a proposed plan version can be confirmed/);
    w.brain.close();
  });

  it("refuses an ineligible assignment or team with the reason, and creates no plan version", async () => {
    const w = withAgents();
    const { id } = await confirmed(w, "ed-refuse");
    const propose = (key: string, team: TeamMember[], tasks: PlanTask[]) => run(w, w.owner, "plan.propose", key, { missionId: id, origin: "manual", team, tasks });
    await fails(async () => await propose("r-tools", TEAM, [task("a", "backend"), task("b", "qa", { requiredTools: ["fixture.echo"] })]), /qa is not eligible for b: missing tools fixture.echo/);
    await fails(async () => await propose("r-cap", TEAM, [task("a", "backend"), task("b", "qa", { maxMicroUsd: 900 })]), /qa is not eligible for b: its spend cap is below the task's/);
    await fails(async () => await propose("r-engine", [...TEAM, member("analyst", "analyst", "Analyst", "pi")], [task("a", "backend"), task("b", "qa")]), /agent analyst does not run on engine pi/);
    await fails(async () => await propose("r-agent", [...TEAM, member("ghost", "nobody")], [task("a", "backend"), task("b", "qa")]), /no published agent definition nobody/);
    await fails(async () => await propose("r-removed", [TEAM[1]!], [task("a", "backend"), task("b", "qa")]), /plan task a is assigned to backend, who is not on the mission team/);
    await fails(async () => await propose("r-noteam", [], [task("a", "backend"), task("b", "qa")]), /plan task a is assigned to backend, who is not on the mission team/);
    await fails(async () => await propose("r-duplicate", [...TEAM, member("qa", "builder")], [task("a", "backend"), task("b", "qa")]), /duplicate team member qa/);
    // A member is bound to its agent definition and engine for the whole mission: changing the binding is a new member, never an edit.
    await fails(async () => await propose("r-rebind", [member("backend", "reviewer", "Backend engineer"), TEAM[1]!], [task("a", "backend"), task("b", "qa")]), /backend is bound to builder on pi/);
    const versions = (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT COUNT(*) AS n FROM plan_versions WHERE mission_id=?").get(id) as { n: number }).n;
    expect(versions).toBe(1);
    w.brain.close();
  });

  it("a member that fits the task is accepted, and eligibility is checked again when the plan is confirmed", async () => {
    const w = withAgents();
    const { id } = await confirmed(w, "ed-fit");
    const team = [...TEAM, member("backend-2", "builder")];
    const fits = (await run(w, w.owner, "plan.propose", "fit-plan", { missionId: id, origin: "manual", team, tasks: [task("a", "backend", { requiredTools: ["fixture.echo"] }), task("b", "backend-2", { requiredTools: ["fixture.echo"] })] })).resourceId ?? "";
    expect((await plan(w, fits)).state).toBe("proposed");
    // The release changes before the person confirms: builder no longer has the tool, so the confirmation is refused with the reason.
    const next = w.brain.stageRelease(w.owner, [...goldenDocs(), agent("builder", {}), agent("reviewer", { maxMicroUsd: 100 })], REVISION, [], [instructions("builder"), instructions("reviewer")]);
    w.brain.activateRelease(w.owner, next.digest);
    await fails(async () => await run(w, w.owner, "plan.confirm", "fit-confirm", { planVersionId: fits }, (await mission(w, id)).version), /backend is not eligible for a: missing tools fixture.echo/);
    expect((await plan(w, fits)).state).toBe("proposed");
    w.brain.close();
  });

  it("never changes started work in place: its task keeps its assignment and its member keeps its binding", async () => {
    const w = withAgents();
    const { id } = await confirmed(w, "ed-started");
    const a = (await items(w)).find((item) => item.planTaskId === "a") as WorkItem;
    w.brain.missions.linkExecution(w.owner, w.workspaceId, a.workItemId, "run-a");
    const team = [...TEAM, member("backend-2", "builder")];
    await fails(async () => await run(w, w.owner, "plan.propose", "st-reassign", { missionId: id, origin: "manual", team, tasks: [task("a", "backend-2"), task("b", "qa")] }), /changes started work: a/);
    // Work that has not started can still be handed over in the same mission.
    const moved = (await run(w, w.owner, "plan.propose", "st-other", { missionId: id, origin: "manual", team, tasks: [task("a", "backend"), task("b", "backend-2")] })).resourceId ?? "";
    await run(w, w.owner, "plan.confirm", "st-other-confirm", { planVersionId: moved }, (await mission(w, id)).version);
    const after = await items(w);
    expect(after.find((item) => item.planTaskId === "a")).toMatchObject({ workItemId: a.workItemId, assignment: { id: "backend" } });
    expect(after.find((item) => item.planTaskId === "b")?.assignment).toEqual({ kind: "agent", id: "backend-2", role: "specialist" });
    w.brain.close();
  });

  it("the autonomy policy still decides: a coordinator's reassignment confirms itself under standard and waits for a person under supervised", async () => {
    const w = withAgents();
    const coordinator: ActorContext = { ...w.owner, kind: "agent" };
    const reassign = async (key: string, autonomy: string) => {
      const { id } = await confirmed(w, key, autonomy);
      const proposed = (await run(w, coordinator, "plan.propose", `${key}-reassign`, { missionId: id, origin: "agent", team: TEAM, tasks: [task("a", "qa"), task("b", "qa")] })).resourceId ?? "";
      return { id, proposed };
    };
    const standard = await reassign("ed-standard", "standard");
    expect((await plan(w, standard.proposed)).state).toBe("confirmed");
    const supervised = await reassign("ed-supervised", "supervised");
    expect((await plan(w, supervised.proposed)).state).toBe("proposed");
    await fails(async () => await run(w, coordinator, "plan.confirm", "ed-supervised-agent-confirm", { planVersionId: supervised.proposed }, (await mission(w, supervised.id)).version), /cannot run plan.confirm/);
    await run(w, w.owner, "plan.confirm", "ed-supervised-human", { planVersionId: supervised.proposed }, (await mission(w, supervised.id)).version);
    expect((await plan(w, supervised.proposed)).state).toBe("confirmed");
    w.brain.close();
  });
});
