import { afterEach, describe, expect, it } from "vitest";
import { setupWorld, DIGEST_A, type TestWorld } from "../helpers";

let world: TestWorld | undefined;
afterEach(() => { world?.brain.close(); world = undefined; });

function seedRunner(world: TestWorld, runnerId: string) {
  const store = world.brain.store;
  store.control.prepare(`INSERT INTO runners(id,organization_id,group_id,identity_key_digest,admin_state,health,config_digest,session_epoch,last_heartbeat_ms,cpu_capacity,memory_capacity,disk_capacity,slot_capacity)
    VALUES (?,?,'fixture-tools','key','enabled','healthy',?,1,?,4000,8192,20480,1)`).run(runnerId, world.org, DIGEST_A, store.now());
  for (const capability of ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture"]) {
    store.control.prepare("INSERT INTO runner_capabilities(runner_id,capability,verified,source,observed_at_ms,expires_at_ms) VALUES (?,?,1,'fixture',?,?)")
      .run(runnerId, capability, store.now(), store.now() + 3600_000);
  }
  return { runnerId, epoch: 1, organizationId: world.org };
}

describe("personal-host schedule execution (E105)", () => {
  it("pins the run and every job to the selected runner, never a managed alternative", () => {
    world = setupWorld();
    const w = world;
    const personal = seedRunner(w, "personal-selected");
    const managed = seedRunner(w, "managed-alternative");
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-personal-create", commandType: "automation.upsert",
      workspaceId: w.workspaceId, idempotencyKey: "personal-create",
      payload: { title: "Personal only", target: { kind: "workflow", id: "fixture-workflow" }, trigger: { kind: "manual" }, input: { message: "personal run" }, execution: { mode: "personal-host", runnerId: personal.runnerId, offlinePolicy: "wait" } },
    }, "personal-create");
    const automation = w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT id FROM automations").get() as { id: string };
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-personal-run", commandType: "automation.control",
      workspaceId: w.workspaceId, idempotencyKey: "personal-run", expectedVersion: 1,
      payload: { automationId: automation.id, action: "runNow" },
    }, "personal-run");
    const job = w.brain.store.control.prepare("SELECT id,placement_json FROM jobs").get() as { id: string; placement_json: string };
    expect(JSON.parse(job.placement_json).runnerId).toBe(personal.runnerId);
    expect(w.brain.claim(managed, "managed-cannot-claim")).toBeNull();
    const offer = w.brain.claim(personal, "personal-can-claim") as { jobId: string } | null;
    expect(offer?.jobId).toBe(job.id);
  });
});
