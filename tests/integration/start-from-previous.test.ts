import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { TaskExperience } from "../../apps/governor/src/modules/workflows/index";
import { putBytes } from "../../apps/governor/src/modules/artifacts/index";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { enrollAndHello, runOnce } from "../../apps/runner/src/supervisor";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "brain-start-from-"));
  const app = await createApp({ dataDir: dir, allowTestActor: true });
  const w = setupWorld(app.brain);
  cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const bundle = fixtureStarter();
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const tasks = new TaskExperience(w.brain.store, {
    query: (actor, query) => w.brain.executeQuery(actor, query),
    dispatch: async (actor, command) => ({ receipt: (await w.brain.executeCommand(actor, command, "task-test")).receipt }),
    reusePrompt: (actor, workspaceId, missionId) => w.brain.reuse.promptFor(actor, workspaceId, missionId),
    startedFrom: (actor, workspaceId, missionId) => w.brain.missions.startedFrom(actor, workspaceId, missionId),
  });
  return { ...w, app, tasks };
}

/** An achieved, closed mission with two verified outputs and one draft, as a finished piece of work leaves behind. */
function seedSource(w: Awaited<ReturnType<typeof world>>, missionId: string, kinds: { closed?: boolean } = {}): { verified: string[]; draft: string } {
  const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
  const now = Date.now();
  db.prepare("INSERT INTO missions(id,title,intent,success_criteria_json,owner_id,state,outcome,created_at_ms,updated_at_ms) VALUES (?,?,?,?,'owner-1',?,?,?,?)")
    .run(missionId, "Vendor comparison", "Compare vendors", '["compared"]', kinds.closed === false ? "active" : "closed", kinds.closed === false ? null : "achieved", now, now);
  db.prepare("INSERT INTO plan_versions(id,mission_id,revision,digest,state,origin,created_by,tasks_json,created_at_ms) VALUES (?,?,1,?,'confirmed','manual','owner-1','[]',?)").run(`plan-${missionId}`, missionId, `sha256:${"a".repeat(64)}`, now);
  db.prepare("INSERT INTO work_items(id,mission_id,plan_version_id,plan_task_id,title,state,criteria_json,next_action,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,'review','[]','Review',?,?)").run(`work-${missionId}`, missionId, `plan-${missionId}`, "compare", "Compare", now, now);
  const verified: string[] = [];
  for (const [index, name] of ["compare", "prices", "risks", "timeline", "summary", "appendix", "extra-one", "extra-two"].entries()) {
    const digest = putBytes(w.brain.store, new TextEncoder().encode(`# ${name}\n\nVerified finding number ${index}.`));
    db.prepare("INSERT INTO mission_outputs(id,mission_id,name,created_at_ms) VALUES (?,?,?,?)").run(`output-${missionId}-${name}`, missionId, name, now + index);
    db.prepare("INSERT INTO output_versions(id,output_id,work_item_id,artifact_digest,state,verified,created_at_ms) VALUES (?,?,?,?,'final',1,?)").run(`outver-${missionId}-${name}`, `output-${missionId}-${name}`, `work-${missionId}`, digest, now + index);
    verified.push(`outver-${missionId}-${name}`);
  }
  const digest = putBytes(w.brain.store, new TextEncoder().encode("draft"));
  db.prepare("INSERT INTO mission_outputs(id,mission_id,name,created_at_ms) VALUES (?,?,?,?)").run(`output-${missionId}-draft`, missionId, "draft-only", now);
  db.prepare("INSERT INTO output_versions(id,output_id,work_item_id,artifact_digest,state,verified,created_at_ms) VALUES (?,?,?,?,'draft',0,?)").run(`outver-${missionId}-draft`, `output-${missionId}-draft`, `work-${missionId}`, digest, now);
  return { verified, draft: `outver-${missionId}-draft` };
}

const startedFromNote = (id: string) => `Started from the earlier mission "Vendor comparison" (${id}); its verified outputs are the starting inputs. Last verified earlier.`;

it("pins the verified outputs of the mission a new one started from as typed inputs, bounded and with provenance (row 34)", async () => {
  const w = await world();
  const db = w.brain.store.workspaceDb(w.workspaceId, w.org);
  const source = seedSource(w, "mission-source-1");
  w.brain.reuse.indexMission(w.org, w.workspaceId, "mission-source-1");
  const created = (await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "c-new", commandType: "mission.create", workspaceId: w.workspaceId, idempotencyKey: "c-new", payload: { title: "Vendor comparison again", intent: "Compare vendors again", successCriteria: ["compared"], constraints: [startedFromNote("mission-source-1")] } } as never, "t")).receipt;
  const missionId = created.resourceId!;

  const pins = w.brain.missions.startedFrom(w.owner, w.workspaceId, missionId)!;
  expect(pins.sourceMissionId).toBe("mission-source-1");
  // Six verified outputs at most, never the draft, each by exact version.
  expect(pins.inputs).toHaveLength(6);
  expect(pins.inputs.map((input) => input.versionId)).toEqual(source.verified.slice(0, 6));
  expect(pins.inputs.every((input) => input.missionId === "mission-source-1")).toBe(true);
  expect(pins.refs[0]).toBe("mission:mission-source-1");

  await w.tasks.startMissionPlan(w.owner, { workspaceId: w.workspaceId, requestId: "plan-from-previous", missionId });
  // The Governor attached the earlier mission as a kept reuse item with its provenance.
  const reused = w.brain.reuse.forMission(w.owner, w.workspaceId, missionId);
  expect(reused.map((item) => item.itemRef)).toContain("mission:mission-source-1");
  expect(reused.find((item) => item.itemRef === "mission:mission-source-1")?.decision).toBe("kept");

  const transport: typeof fetch = async (input, init) => w.app.fetch(new Request(input, init));
  for (const group of ["agents", "evaluators"]) {
    const config = { governorUrl: "http://127.0.0.1:3000", runnerId: `prev-${group}`, stateDir: join(w.dir, group), transport, engines: ["fixture"], capabilities: ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container"] };
    const session = await enrollAndHello(config, w.brain.jobProtocol.issueEnrollment(w.owner, group).token);
    expect(await runOnce(config, session.sessionToken, session.epoch)).toBe(true);
  }
  const proposal = await w.tasks.missionPlan(w.owner, w.workspaceId, missionId);
  expect(proposal.state).toBe("ready");
  const tasks = proposal.plan!.tasks;
  const roots = tasks.filter((task) => task.dependsOn.length === 0);
  expect(roots.length).toBeGreaterThan(0);
  for (const root of roots) expect(root.inputs?.map((input) => input.versionId)).toEqual(source.verified.slice(0, 6));
  for (const later of tasks.filter((task) => task.dependsOn.length > 0)) expect(later.inputs).toBeUndefined();

  // Confirming the plan starts the root task, which pins the exact versions and is shown their text as quoted data.
  const mission = (await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: missionId }) as unknown as { snapshot: { version: number } }).snapshot;
  const confirmed = await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: "confirm-prev", commandType: "plan.confirm", workspaceId: w.workspaceId, idempotencyKey: "confirm-prev", expectedVersion: mission.version, payload: { planVersionId: proposal.planVersionId } }, "t");
  expect(confirmed.receipt.accepted).toBe(true);
  const rootItem = db.prepare("SELECT id FROM work_items WHERE mission_id=? AND plan_task_id=?").get(missionId, roots[0]!.id) as { id: string };
  const run = db.prepare("SELECT run_id FROM execution_links WHERE work_item_id=?").get(rootItem.id) as { run_id: string } | undefined;
  expect(run).toBeDefined();
  expect((db.prepare("SELECT output_version_id FROM work_item_inputs WHERE work_item_id=? ORDER BY output_version_id").all(rootItem.id) as Array<{ output_version_id: string }>).map((row) => row.output_version_id)).toEqual([...source.verified.slice(0, 6)].sort());
  const situation = (JSON.parse((db.prepare("SELECT input_json FROM run_inputs WHERE run_id=?").get(run!.run_id) as { input_json: string }).input_json) as { situation: string }).situation;
  expect(situation).toContain('Earlier verified result "compare" of "Vendor comparison"');
  expect(situation).toContain("Verified finding number 0.");
});

it("ignores a source that is not an achieved closed mission, and a brief that names none", async () => {
  const w = await world();
  seedSource(w, "mission-still-open", { closed: false });
  const make = async (key: string, constraints: string[]) => ((await w.brain.executeCommand(w.owner, { contractVersion: "brain.command/v1", commandId: key, commandType: "mission.create", workspaceId: w.workspaceId, idempotencyKey: key, payload: { title: key, intent: key, successCriteria: ["x"], constraints } } as never, "t")).receipt.resourceId!);
  expect(w.brain.missions.startedFrom(w.owner, w.workspaceId, await make("open-source", [startedFromNote("mission-still-open")]))).toBeUndefined();
  expect(w.brain.missions.startedFrom(w.owner, w.workspaceId, await make("no-note", ["Keep it short"]))).toBeUndefined();
  expect(w.brain.missions.startedFrom(w.owner, w.workspaceId, await make("missing-source", [startedFromNote("mission-ghost")]))).toBeUndefined();
});
