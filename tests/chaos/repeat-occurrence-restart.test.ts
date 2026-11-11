import { describe, expect, it } from "vitest";
import { Brain } from "../../apps/governor/src/application/brain";
import { setupWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

/** ADR 0017: a crash while an occurrence's mission is being started must never leave two missions or a plan nobody decides. */
describe("a scheduled repeat survives a Governor restart mid-occurrence", () => {
  it("starts one mission with exactly one decided plan per occurrence, however often the start is replayed", async () => {
    const world = setupWorld();
    const bundle = fixtureStarter();
    world.brain.activateRelease(world.owner, world.brain.stageRelease(world.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
    let reopened: Brain | undefined;
    try {
      const db = world.brain.store.workspaceDb(world.workspaceId, world.org);
      const command = async (brain: Brain, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number) =>
        (await brain.executeCommand(world.owner, { contractVersion: "brain.command/v1", commandId: `c-${key}`, commandType, workspaceId: world.workspaceId, idempotencyKey: key, ...(expectedVersion ? { expectedVersion } : {}), payload } as never, key)).receipt.resourceId ?? "";
      const source = await command(world.brain, "mission.create", "k1", { title: "Weekly", intent: "Report", successCriteria: ["done"] });
      const plan = await command(world.brain, "plan.propose", "k2", { missionId: source, origin: "manual", tasks: [{ id: "write", title: "Write", criteria: ["written"], dependsOn: [] }] });
      const version = (db.prepare("SELECT version FROM missions WHERE id=?").get(source) as { version: number }).version;
      await command(world.brain, "plan.confirm", "k3", { planVersionId: plan }, version);
      db.prepare("INSERT INTO mission_evidence_bundles(digest,mission_id,state,manifest_json,findings_json,created_at_ms) VALUES (?,?,'verified','{}','[]',?)").run(`sha256:${"5".repeat(64)}`, source, Date.now());
      db.prepare("UPDATE missions SET state='closed', outcome='achieved' WHERE id=?").run(source);

      const start = (brain: Brain, occurrenceId: string) => brain.missions.startFromDescription({
        organizationId: world.org, workspaceId: world.workspaceId, title: "Weekly · run", situation: "Report\n\nDone when:\n- done",
        startedBy: "owner-1", occurrenceId, automationId: "auto-1", sourceMissionId: source, autoConfirm: true,
      });
      const first = start(world.brain, "occ-1");
      world.brain.close();
      reopened = new Brain({ dataDir: world.dir, allowTestActor: true });
      // The occurrence's dispatch was lost with the response, so the start is replayed after the restart (and again).
      expect(start(reopened, "occ-1")).toBe(first);
      expect(start(reopened, "occ-1")).toBe(first);
      const after = reopened.store.workspaceDb(world.workspaceId, world.org);
      expect((after.prepare("SELECT COUNT(*) AS n FROM missions WHERE started_by_occurrence='occ-1'").get() as { n: number }).n).toBe(1);
      expect((after.prepare("SELECT state FROM plan_versions WHERE mission_id=?").all(first) as Array<{ state: string }>).map((row) => row.state)).toEqual(["confirmed"]);
      expect((after.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type IN ('plan.confirmedBySchedule','plan.heldBySchedule') AND json_extract(payload_json,'$.missionId')=?").get(first) as { n: number }).n).toBe(1);
      // A second occurrence is a second mission, decided the same way.
      const second = start(reopened, "occ-2");
      expect(second).not.toBe(first);
      expect((after.prepare("SELECT state FROM plan_versions WHERE mission_id=?").all(second) as Array<{ state: string }>).map((row) => row.state)).toEqual(["confirmed"]);
    } finally {
      reopened?.close();
    }
  });
});
