import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, Mission, PlanTask, PlanVersion, StandingTeam, TeamMember } from "@brain/contracts";
import { goldenDocs, setupWorld } from "../helpers";
import { closeWorlds, freshWorld } from "../support/machine-session";

// Standing teams (ADR 0056): named sets of roles bound to agent definitions and engines, in the Library. A plan or a Play start copies their
// members into the plan version; the standing team is never consulted again for that plan. State is reached through commands only.

afterEach(closeWorlds);

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
const teams = async (w: World) => ((await w.brain.executeQuery(w.owner, { queryType: "standingTeams.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: StandingTeam[] } }).snapshot.items;
const summary = async (w: World) => ((await w.brain.executeQuery(w.owner, { queryType: "library.summary", workspaceId: w.workspaceId })) as unknown as { snapshot: { teams: number } }).snapshot;
const task = (id: string, member: string | undefined, extra: Partial<PlanTask> = {}): PlanTask => ({ id, title: `Task ${id}`, criteria: [`${id}-done`], dependsOn: [], ...(member ? { assignment: { kind: "agent", id: member, role: "specialist" } } : {}), ...extra });
const member = (memberId: string, agentId: string, role = "Engineer", engine = "pi"): TeamMember => ({ memberId, role, agentId, engine });
const agent = (id: string, spec: { tools?: string[]; engines?: string[] }) => {
  const tools = spec.tools?.length ? `  tools:\n${spec.tools.map((tool) => `    - id: ${tool}\n      digest: ${ECHO_DIGEST}\n`).join("")}` : "  tools: []\n";
  return {
    path: `config/${id}.yaml`,
    text: `apiVersion: brain.keyrus/v1\nkind: Agent\nmetadata:\n  id: ${id}\n  version: 1.0.0\nspec:\n  instructionsPath: agents/${id}.md\n${tools}`
      + `  engine:\n    anyOf: [${(spec.engines ?? ["pi"]).join(", ")}]\n    features: [start, events, cancel]\n  maxTurns: 5\n  maxChildren: 0\n  maxDepth: 0\n  maxTokens: 1000\n  maxMicroUsd: 0\n`,
  };
};
const instructions = (id: string) => ({ agentId: id, path: `agents/${id}.md`, text: `# ${id}\n` });
const ECHO_DIGEST = "sha256:a3fe6a4caae9923fc7b88b98a9bb83234540741512decc87707dd2e97e03d6f0";
const REVISION = "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4";

/** A workspace whose release holds a builder (has fixture.echo), a reviewer (no tools) and a claude-only analyst. */
function withAgents(): World {
  const w = setupWorld();
  const release = w.brain.stageRelease(w.owner, [...goldenDocs(), agent("builder", { tools: ["fixture.echo"] }), agent("reviewer", {}), agent("analyst", { tools: ["fixture.echo"], engines: ["claude"] })],
    REVISION, [], [instructions("builder"), instructions("reviewer"), instructions("analyst")]);
  w.brain.activateRelease(w.owner, release.digest);
  return w;
}

const MEMBERS = [member("backend", "builder", "Backend engineer"), member("qa", "reviewer", "Reviewer")];
const create = async (w: World, key: string, payload: Record<string, unknown> = {}): Promise<string> =>
  (await run(w, w.owner, "standingTeam.create", key, { name: `Team ${key}`, members: MEMBERS, ...payload })).resourceId ?? "";
const newMission = async (w: World, key: string): Promise<string> =>
  (await run(w, w.owner, "mission.create", `${key}-mission`, { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"] })).resourceId ?? "";

describe("standing teams in the Library (#130)", () => {
  it("a team is created, edited, listed and counted, and an archived team stays readable but leaves the count", async () => {
    const w = withAgents();
    const id = await create(w, "desk", { name: "Review desk", description: "Builds and checks", coordinatorMemberId: "backend" });
    expect(await teams(w)).toEqual([expect.objectContaining({ standingTeamId: id, name: "Review desk", description: "Builds and checks", members: MEMBERS, coordinatorMemberId: "backend", state: "active", version: 1 })]);
    expect((await summary(w)).teams).toBe(1);

    await run(w, w.owner, "standingTeam.update", "desk-edit", { standingTeamId: id, name: "Delivery desk", members: [...MEMBERS, member("backend-2", "builder", "Backend engineer")] }, 1);
    const [edited] = await teams(w);
    expect(edited).toMatchObject({ name: "Delivery desk", version: 2, coordinatorMemberId: "backend" });
    expect(edited?.members.map((entry) => entry.memberId)).toEqual(["backend", "qa", "backend-2"]);
    // A stale edit is refused, and dropping the coordinator's member is refused with the reason.
    await fails(async () => await run(w, w.owner, "standingTeam.update", "desk-stale", { standingTeamId: id, description: "x" }, 1), /expected version 1 but current is 2/);
    await fails(async () => await run(w, w.owner, "standingTeam.update", "desk-coordinator", { standingTeamId: id, members: [MEMBERS[1]] }, 2), /the coordinator backend is not a member/);
    await run(w, w.owner, "standingTeam.update", "desk-no-coordinator", { standingTeamId: id, coordinatorMemberId: null }, 2);
    expect((await teams(w))[0]?.coordinatorMemberId).toBeUndefined();

    await run(w, w.owner, "standingTeam.archive", "desk-archive", { standingTeamId: id }, 3);
    expect((await teams(w))[0]).toMatchObject({ state: "archived", version: 4 });
    expect((await summary(w)).teams).toBe(0);
    await fails(async () => await run(w, w.owner, "standingTeam.update", "desk-archived-edit", { standingTeamId: id, name: "Again" }, 4), /an archived standing team is read-only/);
    w.brain.close();
  });

  it("refuses members that are not eligible, duplicate names, and anyone but a person", async () => {
    const w = withAgents();
    const make = (key: string, members: TeamMember[], extra: Record<string, unknown> = {}) => run(w, w.owner, "standingTeam.create", key, { name: `T ${key}`, members, ...extra });
    await fails(async () => await make("none", []), /at least one member|must NOT have fewer/i);
    await fails(async () => await make("ghost", [member("ghost", "nobody")]), /no published agent definition nobody/);
    await fails(async () => await make("engine", [member("analyst", "analyst", "Analyst", "pi")]), /agent analyst does not run on engine pi/);
    await fails(async () => await make("dup", [MEMBERS[0]!, member("backend", "reviewer")]), /duplicate team member backend/);
    await fails(async () => await make("coordinator", MEMBERS, { coordinatorMemberId: "boss" }), /the coordinator boss is not a member/);
    await create(w, "first", { name: "Support desk" });
    await fails(async () => await create(w, "again", { name: "support DESK" }), /a standing team named "support DESK" already exists/);
    expect(await teams(w)).toHaveLength(1);
    // Managing standing teams is for a person: an agent's session cannot, even with the same scope.
    const session: ActorContext = { ...w.owner, kind: "agent" };
    await fails(async () => await run(w, session, "standingTeam.create", "agent-create", { name: "Mine", members: MEMBERS }), /standingTeam.create/);
    w.brain.close();
  });

  it("a plan that references a team gets its members as the mission team, and plan and team are confirmed together", async () => {
    const w = withAgents();
    const teamId = await create(w, "ref");
    const id = await newMission(w, "ref");
    const proposed = (await run(w, w.owner, "plan.propose", "ref-plan", { missionId: id, origin: "manual", standingTeamId: teamId, tasks: [task("a", "backend"), task("b", "qa")] })).resourceId ?? "";
    expect(await plan(w, proposed)).toMatchObject({ state: "proposed", team: MEMBERS });
    expect((await mission(w, id)).activePlanVersionId).toBeUndefined();
    await run(w, w.owner, "plan.confirm", "ref-confirm", { planVersionId: proposed }, (await mission(w, id)).version);
    expect(await plan(w, proposed)).toMatchObject({ state: "confirmed", team: MEMBERS });
    expect((await mission(w, id)).activePlanVersionId).toBe(proposed);
    w.brain.close();
  });

  it("members are copied: editing or archiving the standing team never changes a confirmed plan or a mission, only later references", async () => {
    const w = withAgents();
    const teamId = await create(w, "copy");
    const id = await newMission(w, "copy");
    const first = (await run(w, w.owner, "plan.propose", "copy-plan", { missionId: id, origin: "manual", standingTeamId: teamId, tasks: [task("a", "backend"), task("b", "qa")] })).resourceId ?? "";
    await run(w, w.owner, "plan.confirm", "copy-confirm", { planVersionId: first }, (await mission(w, id)).version);
    const confirmedDigest = (await plan(w, first)).digest;

    await run(w, w.owner, "standingTeam.update", "copy-edit", { standingTeamId: teamId, members: [member("backend", "builder", "Lead engineer"), member("qa", "reviewer", "Reviewer"), member("scribe", "reviewer", "Scribe")] }, 1);
    expect(await plan(w, first)).toMatchObject({ state: "confirmed", team: MEMBERS, digest: confirmedDigest });

    // A later reference gets the new members; the confirmed team it extends keeps its own copy of the ones that did not change.
    const second = (await run(w, w.owner, "plan.propose", "copy-plan-2", { missionId: id, origin: "manual", standingTeamId: teamId, tasks: [task("a", "backend"), task("b", "scribe")] })).resourceId ?? "";
    expect((await plan(w, second)).team?.map((entry) => `${entry.memberId}:${entry.role}`)).toEqual(["backend:Lead engineer", "qa:Reviewer", "scribe:Scribe"]);
    expect(await plan(w, first)).toMatchObject({ state: "confirmed", team: MEMBERS });

    await run(w, w.owner, "standingTeam.archive", "copy-archive", { standingTeamId: teamId }, 2);
    expect((await plan(w, second)).team).toHaveLength(3);
    await run(w, w.owner, "plan.confirm", "copy-confirm-2", { planVersionId: second }, (await mission(w, id)).version);
    expect((await plan(w, second)).state).toBe("confirmed");
    // An archived team is refused for a new reference.
    await fails(async () => await run(w, w.owner, "plan.propose", "copy-plan-3", { missionId: id, origin: "manual", standingTeamId: teamId, tasks: [task("a", "backend")] }), /the standing team .* is archived/);
    w.brain.close();
  });

  it("eligibility still applies per task, and a binding collision names the member", async () => {
    const w = withAgents();
    const teamId = await create(w, "elig");
    const id = await newMission(w, "elig");
    const propose = (key: string, extra: Record<string, unknown>, tasks: PlanTask[]) => run(w, w.owner, "plan.propose", key, { missionId: id, origin: "manual", standingTeamId: teamId, tasks, ...extra });
    await fails(async () => await propose("elig-tools", {}, [task("a", "backend"), task("b", "qa", { requiredTools: ["fixture.echo"] })]), /qa is not eligible for b: missing tools fixture.echo/);
    await fails(async () => await propose("elig-unknown", {}, [task("a", "stranger")]), /plan task a is assigned to stranger, who is not on the mission team/);
    // The team named alongside the reference must agree with it: one member id is one binding.
    await fails(async () => await propose("elig-collide", { team: [member("backend", "reviewer")] }, [task("a", "backend")]), /backend is already on the team bound to reviewer on pi, and the standing team binds it to builder on pi/);
    // The same binding on both sides is the same member, once.
    const ok = (await propose("elig-same", { team: [MEMBERS[0]!] }, [task("a", "backend"), task("b", "qa")])).resourceId ?? "";
    expect((await plan(w, ok)).team).toEqual(MEMBERS);
    // The release in force at reference time decides: when the agent has gone, the team cannot be used.
    const next = w.brain.stageRelease(w.owner, [...goldenDocs(), agent("builder", { tools: ["fixture.echo"] })], REVISION, [], [instructions("builder")]);
    w.brain.activateRelease(w.owner, next.digest);
    await fails(async () => await propose("elig-gone", {}, [task("a", "backend")]), /no published agent definition reviewer/);
    w.brain.close();
  });

  it("an agent's session cannot reference a standing team", async () => {
    const w = withAgents();
    const teamId = await create(w, "agent-ref");
    const id = await newMission(w, "agent-ref");
    const session: ActorContext = { ...w.owner, kind: "agent" };
    await fails(async () => await run(w, session, "plan.propose", "agent-ref-plan", { missionId: id, origin: "agent", standingTeamId: teamId, tasks: [task("a", "backend")] }), /only a person references a standing team/);
    w.brain.close();
  });
});

describe("a Play started with a standing team (#130)", () => {
  const PLAY = "research-with-coordinator";
  const rows = (w: World, missionId: string) => w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT team_json, tasks_json FROM plan_versions WHERE mission_id=? ORDER BY revision").all(missionId) as Array<{ team_json: string; tasks_json: string }>;
  const coordinatorOf = (w: World, missionId: string) => (w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT coordinator_member_id AS c FROM missions WHERE id=?").get(missionId) as { c: string | null }).c;

  it("its members replace the Play's team in the plan version; tasks for members it lacks are unassigned; its coordinator leads", async () => {
    const { w } = freshWorld();
    const members = [member("planner", "plan-coordinator", "Planner", "fixture"), member("analyst", "task-worker", "Analyst", "fixture")];
    const teamId = (await run(w, w.owner, "standingTeam.create", "play-team", { name: "Research desk", members, coordinatorMemberId: "planner" })).resourceId ?? "";
    const missionId = (await run(w, w.owner, "mission.create", "play-start", { title: "Venues", playId: PLAY, standingTeamId: teamId, autoStart: false })).resourceId ?? "";
    const [version] = rows(w, missionId);
    expect(JSON.parse(version!.team_json)).toEqual(members);
    expect((JSON.parse(version!.tasks_json) as PlanTask[]).map((entry) => entry.assignment)).toEqual([undefined, undefined]);
    expect(coordinatorOf(w, missionId)).toBe("planner");
    // Editing the standing team afterwards leaves the started mission's plan as it was.
    await run(w, w.owner, "standingTeam.update", "play-team-edit", { standingTeamId: teamId, members: [...members, member("extra", "task-worker", "Extra", "fixture")] }, 1);
    expect(JSON.parse(rows(w, missionId)[0]!.team_json)).toEqual(members);
    // Without a standing team the Play keeps its own team and coordinator.
    const plain = (await run(w, w.owner, "mission.create", "play-plain", { title: "Venues", playId: PLAY, autoStart: false })).resourceId ?? "";
    expect(coordinatorOf(w, plain)).toBe("lead");
    expect((JSON.parse(rows(w, plain)[0]!.team_json) as TeamMember[]).map((entry) => entry.memberId)).toEqual(["lead", "researcher"]);
  });

  it("a Play that runs a coordinator needs a team that names one; an archived team and a Play-less mission are refused", async () => {
    const { w } = freshWorld();
    const members = [member("analyst", "task-worker", "Analyst", "fixture")];
    const leaderless = (await run(w, w.owner, "standingTeam.create", "leaderless", { name: "Analysts", members })).resourceId ?? "";
    await fails(async () => await run(w, w.owner, "mission.create", "play-leaderless", { title: "Venues", playId: PLAY, standingTeamId: leaderless }), /this Play runs a coordinator: choose a standing team that names one/);
    await fails(async () => await run(w, w.owner, "mission.create", "no-play", { title: "x", intent: "y", successCriteria: ["z"], standingTeamId: leaderless }), /this mission has no Play/);
    const led = (await run(w, w.owner, "standingTeam.create", "led", { name: "Led", members: [member("lead", "plan-coordinator", "Lead", "fixture"), ...members], coordinatorMemberId: "lead" })).resourceId ?? "";
    await run(w, w.owner, "standingTeam.archive", "led-archive", { standingTeamId: led }, 1);
    await fails(async () => await run(w, w.owner, "mission.create", "play-archived", { title: "Venues", playId: PLAY, standingTeamId: led }), /is archived/);
  });
});
