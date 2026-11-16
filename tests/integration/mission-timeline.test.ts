import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Mission, MissionTimeline, MissionTimelineEntry, RunToolCalls } from "@brain/contracts";
import { enrollAndHello, runOnce, type RunnerConfig } from "../../apps/runner/src/supervisor";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { command } from "../support/reuse";
import { scaled } from "../support/timing";

// Spec #90, ticket #115 (stories 51 to 53): one chronological mission timeline composed from existing records, and the run's tool calls.
// Everything is reached through commands and real runners: a task proposes a change, a person approves it, the change runs and an
// independent check rules on the work; a second mission runs end to end on the fixture engine and closes itself on a verified verdict.
let world: EffectsWorld | undefined;
afterAll(() => { if (world) rmSync(world.root, { recursive: true, force: true }); });

const read = async <T>(w: EffectsWorld, queryType: string, resourceId: string, extra: Record<string, unknown> = {}, actor = w.w.owner): Promise<T> =>
  ((await w.w.brain.executeQuery(actor, { queryType, workspaceId: w.w.workspaceId, resourceId, ...extra } as never)) as unknown as { snapshot: T }).snapshot;
const timeline = (w: EffectsWorld, missionId: string): Promise<MissionTimeline> => read<MissionTimeline>(w, "missions.timeline", missionId);
const version = async (w: EffectsWorld, missionId: string): Promise<number> => (await read<Mission>(w, "missions.get", missionId)).version;
const shape = (items: readonly MissionTimelineEntry[]) => items.map((entry) => `${entry.kind}:${entry.event}`);
type Runner = { cfg: RunnerConfig; sessionToken: string; epoch: number };

async function runnerOf(w: EffectsWorld, group: string): Promise<Runner> {
  const cfg: RunnerConfig = { ...w.cfg, runnerId: `runner-${group}`, stateDir: join(w.root, `runner-${group}`) };
  return { cfg, ...(await enrollAndHello(cfg, w.w.brain.jobProtocol.issueEnrollment(w.w.owner, group).token)) };
}

/** Runs every claimable job on the host runner and the others (agent work, held effects, independent checks) until nothing is left to claim. */
async function driveAll(w: EffectsWorld, others: readonly Runner[]): Promise<void> {
  const deadline = Date.now() + scaled(60_000);
  for (;;) {
    let worked = (await w.drain()) > 0;
    for (const runner of others) worked = (await runOnce(runner.cfg, runner.sessionToken, runner.epoch)) || worked;
    if (!worked) return;
    if (Date.now() > deadline) throw new Error("the runners did not settle");
  }
}

describe("mission timeline and run tool calls", () => {
  it("joins plan versions, decisions, messages, runs, approvals, effects and verdicts in one order, each naming its source and member", async () => {
    world = await effectsWorld();
    const w = world;
    const team = [{ memberId: "sre", role: "Site reliability engineer", agentId: "sre-operator", engine: "fixture" }];
    const missionId = (await w.command("mission.create", "t-create", { title: "Restart the unhealthy app", intent: "Restart demo-app", successCriteria: ["restarted"], autoStart: false })).resourceId!;
    const planId = (await w.command("plan.propose", "t-plan", { missionId, origin: "manual", summary: "Restart the app once", team, tasks: [{ id: "a", title: "Restart", criteria: ["restarted"], dependsOn: [], assignment: { kind: "agent", id: "sre", role: "specialist" } }] })).resourceId!;
    await command(w.w, w.w.owner, "plan.confirm", "t-confirm", { planVersionId: planId }, await version(w, missionId));
    const brief = await read<{ version: number }>(w, "missions.brief", missionId);
    const decisionId = (await w.command("decision.accept", "t-decision", { missionId, baseVersion: brief.version, statement: "Restart only the unhealthy container", source: { kind: "human" } })).resourceId!;
    const messageId = (await w.command("mission.message.send", "t-msg", { missionId, recipient: { kind: "member", memberId: "sre" }, body: "Look at the logs first" })).resourceId!;

    const workItemId = (w.store.workspaceDb(w.w.workspaceId, w.w.org).prepare("SELECT id FROM work_items WHERE mission_id=?").get(missionId) as { id: string }).id;
    const runId = (await w.dispatch("timeline")).resourceId!;
    w.w.brain.missions.linkExecution(w.w.owner, w.w.workspaceId, workItemId, runId);
    expect(await w.run()).toBe(true);
    const approval = await w.pendingApproval();

    // The request is on the timeline while it waits, linked to its approval and attributed to the member whose task asked.
    const waiting = await timeline(w, missionId);
    expect(shape(waiting.items)).toEqual(["plan:plan.proposed", "plan:plan.confirmed", "decision:decision.accepted", "message:message.sent", "run:run.started", "approval:approval.requested"]);
    expect(waiting.items.find((entry) => entry.kind === "approval")).toMatchObject({ memberId: "sre", subject: 'Restart the container "demo-app" on the demos host', source: { kind: "approval", id: approval.id } });

    const evaluator = await runnerOf(w, "evaluators");
    await w.decide(approval, "approve");
    await driveAll(w, [evaluator]);

    const full = await timeline(w, missionId);
    // One total order: time, then kind, then record. Reading it twice gives the same answer.
    const stamps = full.items.map((entry) => entry.at);
    expect([...stamps].sort()).toEqual(stamps);
    expect(await timeline(w, missionId)).toEqual(full);
    expect(new Set(full.items.map((entry) => entry.kind))).toEqual(new Set(["plan", "decision", "message", "run", "approval", "effect", "verdict"]));
    const where = (kind: string, event: string) => full.items.findIndex((entry) => entry.kind === kind && entry.event === event);
    expect(where("approval", "approval.requested")).toBeLessThan(where("approval", "approval.decided"));
    expect(where("approval", "approval.decided")).toBeLessThan(where("effect", "effect.settled"));
    expect(where("plan", "plan.proposed")).toBeLessThan(where("plan", "plan.confirmed"));

    // Each entry names its source record.
    const entry = (kind: string, event: string) => full.items[where(kind, event)]!;
    expect(entry("plan", "plan.confirmed")).toMatchObject({ revision: 1, source: { kind: "plan", id: planId } });
    expect(entry("decision", "decision.accepted")).toMatchObject({ subject: "Restart only the unhealthy container", source: { kind: "decision", id: decisionId } });
    expect(entry("message", "message.sent")).toMatchObject({ memberId: "sre", source: { kind: "message", id: messageId } });
    const jobId = (w.store.control.prepare("SELECT id FROM jobs WHERE workflow_run_id=? ORDER BY created_at_ms, rowid LIMIT 1").get(runId) as { id: string }).id;
    expect(entry("run", "run.started")).toMatchObject({ subject: "Restart", memberId: "sre", source: { kind: "run", id: runId, jobId } });
    expect(entry("approval", "approval.decided")).toMatchObject({ outcome: "approve", source: { kind: "approval", id: approval.id } });
    expect(entry("effect", "effect.settled")).toMatchObject({ outcome: "applied", memberId: "sre", source: { kind: "approval", id: approval.id } });
    expect(entry("verdict", "verdict.task")).toMatchObject({ memberId: "sre", source: { kind: "run", id: runId, jobId } });
    expect(full.members).toEqual([{ memberId: "sre", role: "Site reliability engineer" }]);
    expect(full.truncated).toBe(false);

    // The run page reads the same run's tool calls, in the order they were made, the change's call naming its approval.
    const calls = await read<RunToolCalls>(w, "run.toolCalls", runId);
    expect(calls.truncated).toBe(false);
    expect(calls.items.map((call) => [call.toolId, call.outcome])).toEqual([["host.exec", "succeeded"], ["host.restart", "succeeded"], ["host.exec", "succeeded"], ["host.restart", "succeeded"]]);
    expect(calls.items.map((call) => call.attemptNumber)).toEqual([1, 1, 2, 2]);
    expect(calls.items[1]).toMatchObject({ approvalId: approval.id });
    expect(calls.items[0]!.approvalId).toBeUndefined();
    expect(entry("run", "run.started").toolCalls).toBe(calls.items.length);
    await expect(read(w, "run.toolCalls", "run-does-not-exist")).rejects.toThrow(/run not found/);
  }, scaled(180_000));

  it("a mission that runs end to end shows its outputs and verdicts; another mission's records never mix in; a limit keeps the newest", async () => {
    const w = world ?? (world = await effectsWorld());
    const runners = [await runnerOf(w, "agents"), await runnerOf(w, "evaluators")];
    const missionId = (await w.command("mission.create", "e-create", { title: "Stabilize sign-in", intent: "Triage the sign-in flow", successCriteria: ["The flow is inspected"] })).resourceId!;
    const task = { id: "inspect", title: "Inspect the sign-in flow", criteria: ["The findings are written up", "The assumptions are stated"], dependsOn: [] };
    const planId = (await w.command("plan.propose", "e-plan", { missionId, origin: "manual", tasks: [task] })).resourceId!;
    await command(w.w, w.w.owner, "plan.confirm", "e-confirm", { planVersionId: planId }, await version(w, missionId));
    const db = w.store.workspaceDb(w.w.workspaceId, w.w.org);
    const deadline = Date.now() + scaled(90_000);
    while ((db.prepare("SELECT state FROM missions WHERE id=?").get(missionId) as { state: string }).state !== "closed") {
      if (Date.now() > deadline) throw new Error("the mission did not finish");
      let worked = false;
      for (const runner of runners) worked = (await runOnce(runner.cfg, runner.sessionToken, runner.epoch)) || worked;
      if (!worked) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const full = await timeline(w, missionId);
    expect(new Set(full.items.map((entry) => entry.kind))).toEqual(new Set(["plan", "run", "verdict", "output"]));
    expect(shape(full.items)).toEqual(expect.arrayContaining(["verdict:verdict.task", "verdict:verdict.submitted", "verdict:verdict.mission", "output:output.recorded"]));
    const outputId = (db.prepare("SELECT output_id FROM output_versions LIMIT 1").get() as { output_id: string }).output_id;
    expect(full.items.find((entry) => entry.kind === "output")).toMatchObject({ outcome: "verified", source: { kind: "output", id: outputId } });
    // The mission closed itself on its tasks' independent checks: the verdict is the Governor's own principal's and claims no person's sign-off.
    const verdict = full.items.find((entry) => entry.event === "verdict.mission");
    expect(verdict).toMatchObject({ outcome: "verified", actorId: "system:governor", source: { kind: "mission", id: missionId } });
    expect(verdict?.independence).toBeUndefined();
    expect(full.items.find((entry) => entry.event === "plan.proposed")).toMatchObject({ outcome: "manual" });
    // The first mission's approval and effect are not here: a timeline holds one mission's records only.
    expect(full.items.some((entry) => entry.kind === "approval" || entry.kind === "effect")).toBe(false);

    const newest = await read<MissionTimeline>(w, "missions.timeline", missionId, { limit: 2 });
    expect(newest.truncated).toBe(true);
    expect(newest.items.map((entry) => entry.entryId)).toEqual(full.items.slice(-2).map((entry) => entry.entryId));
  }, scaled(180_000));

  it("a plan the plan guide drafted for a person says it was an agent draft requested by that person", async () => {
    const w = world ?? (world = await effectsWorld());
    const missionId = (await w.command("mission.create", "g-create", { title: "Guided mission", intent: "Plan with the guide", successCriteria: ["done"], autoStart: false })).resourceId!;
    await w.command("plan.propose", "g-plan", { missionId, origin: "agent", summary: "Drafted by the guide", tasks: [{ id: "a", title: "Do it", criteria: ["done"], dependsOn: [] }] });
    const entry = (await timeline(w, missionId)).items.find((item) => item.event === "plan.proposed");
    expect(entry).toMatchObject({ outcome: "plan-guide", actorId: w.w.owner.actorId });
    // A coordinator's own proposal is also origin agent but is created by its agent principal: that is not the plan guide acting for a person.
    w.store.workspaceDb(w.w.workspaceId, w.w.org).prepare("UPDATE plan_versions SET created_by='agent:coordinator-1' WHERE mission_id=?").run(missionId);
    expect((await timeline(w, missionId)).items.find((item) => item.event === "plan.proposed")).toMatchObject({ outcome: "agent", actorId: "agent:coordinator-1" });
  }, scaled(60_000));

  it("only someone who may read the workspace reads a mission's timeline", async () => {
    const w = world ?? (world = await effectsWorld());
    const missionId = (w.store.workspaceDb(w.w.workspaceId, w.w.org).prepare("SELECT id FROM missions LIMIT 1").get() as { id: string }).id;
    await expect(read(w, "missions.timeline", missionId, {}, { ...w.w.owner, actorId: "stranger", scopes: [] })).rejects.toThrow(/workspace not found/);
    await expect(read(w, "missions.timeline", "mission-unknown")).rejects.toThrow(/not found/);
  }, scaled(60_000));
});
