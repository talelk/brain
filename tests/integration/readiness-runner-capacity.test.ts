import { describe, expect, it } from "vitest";
import { operationalReadiness } from "../../apps/governor/src/modules/operations/readiness";
import { runnerCapacity } from "../../apps/runner/src/supervisor";
import { setupWorld, DIGEST_A } from "../helpers";
import type { TestWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";

// Readiness separates capability (does an enabled, healthy, capable runner exist) from capacity (is a slot free
// right now). A busy runner is ready ("busy: N of M slots in use"); only a missing runner is "missing".
const CAPS = ["os:linux", "tool:bash", "tool:python3", "isolation:ephemeral-container", "engine:fixture", "engine-feature:fixture:sessions"];

interface RunnerOptions { slots?: number; reserved?: number; adminState?: string; ageMs?: number; caps?: string[] }

function seedRunner(w: TestWorld, id: string, group: string, opts: RunnerOptions = {}) {
  const s = w.brain.store;
  const reserved = opts.reserved ?? 0;
  s.control.prepare(`INSERT INTO runners(id,organization_id,group_id,identity_key_digest,admin_state,health,config_digest,session_epoch,last_heartbeat_ms,cpu_capacity,memory_capacity,disk_capacity,slot_capacity,slots_reserved,cpu_reserved,memory_reserved,disk_reserved)
    VALUES (?,?,?,'k',?,'healthy',?,1,?,4000,8192,20480,?,?,?,?,?)`)
    .run(id, w.org, group, opts.adminState ?? "enabled", DIGEST_A, s.now() - (opts.ageMs ?? 0), opts.slots ?? 1, reserved, reserved * 500, reserved * 256, reserved * 256);
  for (const cap of opts.caps ?? CAPS) s.control.prepare("INSERT INTO runner_capabilities(runner_id,capability,verified,source,observed_at_ms,expires_at_ms) VALUES (?,?,1,'test',?,?)").run(id, cap, s.now(), s.now() + 3600_000);
}

function world(agent: RunnerOptions, withEvaluator = true): TestWorld {
  const w = setupWorld();
  const bundle = fixtureStarter();
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  seedRunner(w, "runner-agents-1", "agents", agent);
  if (withEvaluator) seedRunner(w, "runner-evaluators-1", "evaluators");
  return w;
}

const task = (w: TestWorld) => operationalReadiness(w.brain.store, w.owner, w.workspaceId).checks.find((check) => check.id === "workflow:general-task")!;

describe("runner readiness: capability versus capacity", () => {
  it("an idle runner is ready with no busy note", () => {
    const check = task(world({ slots: 3 }));
    expect(check.status).toBe("ready");
    expect(check.busy).toBeUndefined();
    expect(check.detail).not.toContain("busy");
  });

  it("a runner with every slot in use is still ready and says how busy it is", () => {
    const check = task(world({ slots: 1, reserved: 1 }));
    expect(check.status).toBe("ready");
    expect(check.busy).toEqual({ slotsInUse: 1, slotsTotal: 1 });
    expect(check.detail).toBe("busy: 1 of 1 slots in use; new work queues and starts next");
  });

  it("a runner with a free slot among several is not busy", () => {
    const check = task(world({ slots: 3, reserved: 2 }));
    expect(check.status).toBe("ready");
    expect(check.busy).toBeUndefined();
  });

  it("a runner whose heartbeat is stale is missing", () => {
    const check = task(world({ ageMs: 120_000 }));
    expect(check.status).toBe("missing");
    expect(check.detail).toContain("No online capable runner: agents");
  });

  it("a runner without the required engine is missing, even when idle", () => {
    expect(task(world({ caps: CAPS.filter((cap) => !cap.startsWith("engine")) })).status).toBe("missing");
  });

  it("a disabled runner is missing, even when idle", () => {
    expect(task(world({ adminState: "disabled" })).status).toBe("missing");
  });

  it("a draining runner is missing: it takes no new work", () => {
    expect(task(world({ adminState: "draining" })).status).toBe("missing");
  });

  it("a busy agent runner without any evaluator is still missing for the evaluator group", () => {
    const check = task(world({ slots: 1, reserved: 1 }, false));
    expect(check.status).toBe("missing");
    expect(check.detail).toContain("evaluators");
  });
});

describe("runner capacity configuration", () => {
  it("defaults to one slot and 4000 millicores / 8192 MB, and follows the environment", () => {
    expect(runnerCapacity({})).toMatchObject({ slots: 1, cpuMillicores: 4000, memoryMb: 8192 });
    expect(runnerCapacity({ BRAIN_RUNNER_SLOTS: "3", BRAIN_RUNNER_CPU_MILLICORES: "6000", BRAIN_RUNNER_MEMORY_MB: "16384" })).toMatchObject({ slots: 3, cpuMillicores: 6000, memoryMb: 16384 });
    expect(runnerCapacity({ BRAIN_RUNNER_SLOTS: "0" }).slots).toBe(1);
    expect(runnerCapacity({ BRAIN_RUNNER_SLOTS: "x" }).slots).toBe(1);
  });
});
