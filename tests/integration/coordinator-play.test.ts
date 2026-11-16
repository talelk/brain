import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditEntry, CommandReceipt, Mission, PlanTask, PlanVersion, TeamMember } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

// ADR 0048: the starter Play "Research and write, planned by a coordinator", run end to end on the fixture engine. The coordinator is woken by
// the Governor, reads its context pack, and plans through the Brain tool as its own machine principal; the Governor starts the work.

const tmp = process.env["TMPDIR"] ?? "/tmp";
type App = Awaited<ReturnType<typeof createApp>>;
type World = ReturnType<typeof setupWorld>;
type Session = { cfg: Parameters<typeof runOnce>[0]; sessionToken: string; epoch: number };
const PLAY = "research-with-coordinator";

async function boot<T>(body: (context: { w: World; app: App; agents: Session; evaluators: Session; cfg: Parameters<typeof runOnce>[0] }) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmp, "brain-coordinator-play-"));
  const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
  try {
    const w = setupWorld(app.brain);
    const bundle = fixtureStarter();
    w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
    const transport: typeof fetch = async (input, init) => app.fetch(new Request(input, init));
    const runner = async (group: string): Promise<Session & { cfg: Parameters<typeof runOnce>[0] }> => {
      const stateDir = join(root, group);
      mkdirSync(stateDir, { recursive: true });
      const cfg = { governorUrl: "http://127.0.0.1:3000", runnerId: `runner-${group}`, stateDir, capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"], engines: ["fixture"], transport };
      const hello = await enrollAndHello(cfg, w.brain.jobProtocol.issueEnrollment(w.owner, group).token);
      return { cfg, sessionToken: hello.sessionToken, epoch: hello.epoch };
    };
    const agents = await runner("agents");
    return await body({ w, app, agents, evaluators: await runner("evaluators"), cfg: agents.cfg });
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}

async function run(w: World, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key)).receipt;
}
const query = async <T>(w: World, queryType: string, resourceId?: string): Promise<T> => ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) } as never)) as unknown as { snapshot: T }).snapshot;
const missionOf = (w: World, id: string) => query<Mission>(w, "missions.get", id);
const planRows = (w: World, missionId: string) => w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id, revision, state, origin, created_by, summary, tasks_json FROM plan_versions WHERE mission_id=? ORDER BY revision").all(missionId) as
  Array<{ id: string; revision: number; state: string; origin: string; created_by: string; summary: string | null; tasks_json: string }>;
const taskIds = (row: { tasks_json: string }): string[] => (JSON.parse(row.tasks_json) as PlanTask[]).map((entry) => entry.id);
const coordinatorRuns = (w: World, missionId: string) => w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT m.run_id AS runId, r.state AS state FROM mission_runs m JOIN workflow_runs r ON r.id=m.run_id WHERE m.mission_id=? ORDER BY m.created_at_ms, m.rowid").all(missionId) as Array<{ runId: string; state: string }>;

/** What the Governor's maintenance pass and the runners do, until the condition holds. */
async function drive(w: World, sessions: readonly Session[], until: () => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await until())) {
    if (Date.now() > deadline) {
      const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
      const where = { wakes: db.prepare("SELECT reason, detail, consumed_by_run AS run, last_error AS error FROM mission_wakes").all(), runs: db.prepare("SELECT run_id, purpose FROM mission_runs").all(), states: db.prepare("SELECT id, state FROM workflow_runs").all(),
        items: db.prepare("SELECT plan_task_id AS task, state, parked, next_action FROM work_items").all(), jobs: w.brain.store.control.prepare("SELECT step_id, state, workflow_run_id FROM jobs").all() };
      throw new Error(`the mission did not get there in time: ${JSON.stringify(where)}`);
    }
    w.brain.missions.pumpCoordinators();
    await w.brain.autoStart.sweepAll();
    let worked = false;
    for (const session of sessions) worked = (await runOnce(session.cfg, session.sessionToken, session.epoch)) || worked;
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function startFromPlay(w: World, key: string, extra: Record<string, unknown> = {}): Promise<{ missionId: string; startingPlanId: string }> {
  const missionId = (await run(w, "mission.create", `${key}-create`, { title: "Research the offsite venues", playId: PLAY, ...extra })).resourceId ?? "";
  return { missionId, startingPlanId: planRows(w, missionId)[0]!.id };
}
const confirmStart = async (w: World, missionId: string, planId: string, key: string) => run(w, "plan.confirm", `${key}-confirm`, { planVersionId: planId }, (await missionOf(w, missionId)).version);

describe("the starter Play with a coordinator", () => {
  it("starts a mission whose team has a coordinator, and says which member it is", async () => {
    await boot(async ({ w }) => {
      const { missionId } = await startFromPlay(w, "team");
      const mission = await missionOf(w, missionId);
      expect(mission).toMatchObject({ playId: PLAY, coordinatorMemberId: "lead", state: "active" });
      const plan = await query<PlanVersion>(w, "plans.get", mission.activePlanVersionId ?? planRows(w, missionId)[0]!.id);
      expect((plan.team ?? []).map((member: TeamMember) => `${member.memberId}:${member.agentId}`)).toEqual(["lead:plan-coordinator", "researcher:task-worker"]);
      // A mission from any other Play has no coordinator.
      const plain = (await run(w, "mission.create", "plain-create", { title: "Plain", playId: "research-and-write" })).resourceId ?? "";
      expect((await missionOf(w, plain)).coordinatorMemberId).toBeUndefined();
    });
  });

  it("wakes the coordinator when the starting plan is confirmed; its proposal inside the policy confirms itself; the Governor starts the work and wakes it again after an outcome", async () => {
    await boot(async ({ w, agents, evaluators }) => {
      const { missionId, startingPlanId } = await startFromPlay(w, "flow");
      // Nothing has happened that could change the plan: no wake, no coordinator run.
      expect(w.brain.missions.pumpCoordinators()).toBe(0);
      await confirmStart(w, missionId, startingPlanId, "flow");
      expect(w.brain.missions.pumpCoordinators()).toBe(1);
      expect(coordinatorRuns(w, missionId)).toHaveLength(1);

      // The coordinator reads its pack and proposes through the Brain tool: confirmed at once, as its own principal.
      await drive(w, [agents, evaluators], () => planRows(w, missionId).length >= 2);
      const [starting, revised] = planRows(w, missionId);
      expect(starting).toMatchObject({ state: "superseded", origin: "template" });
      expect(revised).toMatchObject({ state: "confirmed", origin: "agent", created_by: `agent:${missionId}:lead` });
      expect(taskIds(revised!)).toEqual(["gather", "write", "check-sources"]);
      expect((await missionOf(w, missionId)).activePlanVersionId).toBe(revised!.id);
      const acted = (await query<{ items: AuditEntry[] }>(w, "audit.list")).items.filter((entry) => entry.actorId === `agent:${missionId}:lead`);
      expect(acted[0]).toMatchObject({ actorId: `agent:${missionId}:lead`, actingFor: w.owner.actorId });

      // The pack the coordinator was given is the mission as a planner needs it, never the plan it could not see.
      const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
      const firstRun = coordinatorRuns(w, missionId)[0]!.runId;
      const job = w.brain.store.control.prepare("SELECT p.payload_json AS payload FROM jobs j JOIN job_payloads p ON p.job_id=j.id WHERE j.workflow_run_id=? AND j.step_id='plan'").get(firstRun) as { payload: string };
      const pack = (JSON.parse(job.payload) as { contextPack: { text: string } }).contextPack.text;
      expect(pack).toContain("c1: The brief answers the question asked in the goal");
      expect(pack).toContain("Autonomy policy standard: ");
      expect(pack).toMatch(/Tasks: \[\{"id":"gather"/u);
      expect(pack).toContain("- lead: Coordinator (agent plan-coordinator");
      // Where the work stands is read when the coordinator's job is first offered, so it may already have moved.
      expect(pack).toMatch(/^- gather: (not started|in-progress|review|done)/mu);

      // The Governor starts the ready work (the coordinator only plans), and a verified outcome wakes the coordinator, which re-plans inside the policy.
      await drive(w, [agents, evaluators], () => planRows(w, missionId).length >= 3, 40_000);
      const rows = planRows(w, missionId);
      expect(rows[2]).toMatchObject({ state: "confirmed", origin: "agent", created_by: `agent:${missionId}:lead`, summary: "Follow up on what gather found" });
      expect(taskIds(rows[2]!)).toEqual(["gather", "write", "check-sources", "follow-up"]);
      expect(rows[1]!.state).toBe("superseded");

      // The mission finishes only after the coordinator had its say: all work is done and no wake is waiting.
      await drive(w, [agents, evaluators], async () => ["verifying", "closed"].includes((await missionOf(w, missionId)).state), 120_000);
      const states = db.prepare("SELECT plan_task_id AS task, state FROM work_items WHERE mission_id=? AND state!='abandoned' ORDER BY plan_task_id").all(missionId);
      expect(states).toEqual([{ task: "check-sources", state: "done" }, { task: "follow-up", state: "done" }, { task: "gather", state: "done" }, { task: "write", state: "done" }]);
      expect((db.prepare("SELECT COUNT(*) AS n FROM mission_wakes WHERE mission_id=? AND consumed_by_run IS NULL").get(missionId) as { n: number }).n).toBe(0);
      expect(coordinatorRuns(w, missionId).every((entry) => entry.state === "succeeded")).toBe(true);
    });
  }, 300_000);
});
