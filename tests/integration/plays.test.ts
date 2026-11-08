import { describe, expect, it } from "vitest";
import type { CommandReceipt, Mission, MissionBrief, PlanVersion } from "@brain/contracts";
import { goldenDocs, setupWorld } from "../helpers";

type World = ReturnType<typeof setupWorld>;
const SOURCE = "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4";

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId,
    idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const query = async <T>(w: World, queryType: string, resourceId?: string) => ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) })) as { snapshot: T }).snapshot;

const agent = (id: string) => ({ path: `config/${id}.yaml`, text: `apiVersion: brain.keyrus/v1\nkind: Agent\nmetadata:\n  id: ${id}\n  version: 1.0.0\nspec:\n  instructionsPath: agents/${id}.md\n  tools: []\n  engine:\n    anyOf: [pi]\n    features: [start, events, cancel]\n  maxTurns: 5\n  maxChildren: 0\n  maxDepth: 0\n  maxTokens: 1000\n  maxMicroUsd: 0\n` });
const play = (id: string, extra = "") => ({ path: `config/plays/${id}.yaml`, text: `apiVersion: brain.keyrus/v1
kind: Play
metadata:
  id: ${id}
  version: 1.0.0
spec:
  title: Stabilize authentication
  intent: Find and fix session expiry
  successCriteria: [Sessions survive restarts]
  constraints: [Keep the public API]
  team:
    - { memberId: lead, role: Coordinator, agentId: builder, engine: pi }
    - { memberId: backend, role: Backend engineer, agentId: builder, engine: pi }
  coordinator: lead
  plan:
    tasks:
      - { id: audit, title: Audit sessions, criteria: [audit-done], dependsOn: [], assignment: { kind: agent, id: backend, role: specialist } }
      - { id: fix, title: Fix expiry, criteria: [fix-done], dependsOn: [audit], assignment: { kind: agent, id: backend, role: specialist } }
  autonomy: autonomous
  parkingThreshold: 2
  budget: { maxMicroUsd: 500000, memberCap: 2 }
${extra}` });

function stage(w: World, docs: Array<{ path: string; text: string }>) {
  return w.brain.stageRelease(w.owner, [...goldenDocs(), agent("builder"), ...docs], SOURCE, [], [{ agentId: "builder", path: "agents/builder.md", text: "# Builder\n" }]);
}

describe("plays (T63)", () => {
  it("compiles a Play whose team is eligible, rejects one that is not, and lists it from the active release", async () => {
    const w = setupWorld();
    expect(() => stage(w, [{ path: "config/plays/broken.yaml", text: play("broken").text.replace("{ memberId: lead, role: Coordinator, agentId: builder, engine: pi }", "{ memberId: lead, role: Coordinator, agentId: builder, engine: claude }") }])).toThrow(/does not run on engine claude/);
    expect(() => stage(w, [{ path: "config/plays/nolead.yaml", text: play("nolead").text.replace("coordinator: lead", "coordinator: ghost") }])).toThrow(/coordinator ghost is not on its team/);
    w.brain.activateRelease(w.owner, stage(w, [play("auth-stabilize")]).digest);
    const plays = await query<{ items: Array<{ playId: string; taskCount: number; autonomy: string }> }>(w, "plays.list");
    expect(plays.items).toEqual([expect.objectContaining({ playId: "auth-stabilize", taskCount: 2, autonomy: "autonomous" })]);
    w.brain.close();
  });

  it("starts a mission from a Play: brief, policy within the workspace ceiling, budget and a proposed plan with its team", async () => {
    const w = setupWorld();
    w.brain.activateRelease(w.owner, stage(w, [play("auth-stabilize")]).digest);
    const workspace = w.brain.store.control.prepare("SELECT version FROM workspaces WHERE id=?").get(w.workspaceId) as { version: number };
    await (await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "cmd-ceiling", commandType: "workspace.autonomyCeiling.set", workspaceId: w.workspaceId, idempotencyKey: "ceiling", expectedVersion: workspace.version, payload: { workspaceId: w.workspaceId, operations: ["task.add", "task.change", "decision.accept"] } } as never, "ceiling")).receipt;
    const id = (await run(w, "mission.create", "play-mission", { title: "Auth, from the play", playId: "auth-stabilize" })).resourceId ?? "";
    const mission = await query<Mission>(w, "missions.get", id);
    expect(mission).toMatchObject({ state: "active", parkingThreshold: 2, budget: { maxMicroUsd: 500000, memberCap: 2 }, autonomyPolicy: { preset: "autonomous", operations: ["decision.accept", "task.add", "task.change"] } });
    expect(await query<MissionBrief>(w, "missions.brief", id)).toMatchObject({ intent: "Find and fix session expiry", constraints: ["Keep the public API"] });
    const plans = w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id FROM plan_versions WHERE mission_id=?").all(id) as Array<{ id: string }>;
    expect(plans).toHaveLength(1);
    const plan = await query<PlanVersion>(w, "plans.get", plans[0]!.id);
    expect(plan).toMatchObject({ state: "proposed", origin: "template" });
    expect(plan.team?.map((member) => member.memberId)).toEqual(["lead", "backend"]);
    await expect(Promise.resolve().then(async () => await run(w, "mission.policy.set", "play-widen", { missionId: id, preset: "autonomous" }, mission.version))).rejects.toThrow(/ceiling does not allow/);
    await expect(Promise.resolve().then(async () => await run(w, "mission.create", "play-missing", { title: "Nope", playId: "ghost" }))).rejects.toThrow(/not in the active release/);
    w.brain.close();
  });

  it("a scheduled Play starts a mission for its creator; overlap skip waits for that mission to close (T52)", async () => {
    const w = setupWorld();
    w.brain.activateRelease(w.owner, stage(w, [play("auth-stabilize")]).digest);
    const automations = w.brain.jobProtocol.automations;
    const automationId = automations.apply(w.owner, { commandType: "automation.upsert", workspaceId: w.workspaceId, payload: { title: "Weekly auth review", target: { kind: "play", id: "auth-stabilize" }, trigger: { kind: "manual" }, overlap: "skip" } });
    automations.apply(w.owner, { commandType: "automation.control", workspaceId: w.workspaceId, expectedVersion: 1, payload: { automationId, action: "runNow" } });
    const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
    const started = db.prepare("SELECT id, owner_id, play_id FROM missions").all() as Array<{ id: string; owner_id: string; play_id: string }>;
    expect(started).toEqual([expect.objectContaining({ owner_id: "owner-1", play_id: "auth-stabilize" })]);
    const missionId = started[0]!.id;
    expect((db.prepare("SELECT state FROM plan_versions WHERE mission_id=?").get(missionId) as { state: string }).state).toBe("proposed");
    automations.apply(w.owner, { commandType: "automation.control", workspaceId: w.workspaceId, expectedVersion: 1, payload: { automationId, action: "runNow" } });
    const occurrences = db.prepare("SELECT state, dispatch_ref, detail FROM automation_occurrences WHERE automation_id=? ORDER BY planned_at_ms, id").all(automationId) as Array<{ state: string; dispatch_ref: string | null; detail: string | null }>;
    expect(occurrences.map((row) => row.state)).toEqual(["dispatched", "skipped"]);
    expect(occurrences[0]!.dispatch_ref).toBe(missionId);
    const mission = await query<Mission>(w, "missions.get", missionId);
    await run(w, "mission.close", "auto-close", { missionId, outcome: "ended" }, mission.version);
    automations.apply(w.owner, { commandType: "automation.control", workspaceId: w.workspaceId, expectedVersion: 1, payload: { automationId, action: "runNow" } });
    expect((db.prepare("SELECT COUNT(*) AS n FROM missions").get() as { n: number }).n).toBe(2);
    w.brain.close();
  });
});
