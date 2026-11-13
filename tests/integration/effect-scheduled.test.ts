import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { scaled } from "../support/timing";

/**
 * A scheduled watch that proposes and, once approved, acts (ADR 0024): the schedule only starts the same task; each change it proposes
 * stops at its own approval. A later occurrence gets no authority from an earlier one.
 */
let world: EffectsWorld | undefined;
afterAll(() => { if (world) rmSync(world.root, { recursive: true, force: true }); });

describe("scheduled watch: propose, then act once approved", () => {
  it("asks again at every occurrence and restarts only what the owner approved each time", async () => {
    world = await effectsWorld();
    const w = world;
    const situation = ["Look at the demos containers and restart the unhealthy one", "Acceptance criteria:", "1. Says what was checked",
      `FIXTURE_CALL_TOOL ${JSON.stringify({ id: "host.exec", input: { command: "docker.ps" } })}`, `FIXTURE_CALL_TOOL ${JSON.stringify({ id: "host.restart", input: { container: "demo-app" } })}`].join("\n");
    const automationId = (await w.command("automation.upsert", "watch", { title: "Keep the demos server healthy", target: { kind: "workflow", id: "sre-task" }, trigger: { kind: "manual" }, input: { situation }, overlap: "queue-one" })).resourceId!;
    expect(automationId).toBeTruthy();

    await w.command("automation.control", "run-1", { automationId, action: "runNow" });
    expect(await w.run()).toBe(true);
    const approval1 = await w.pendingApproval();
    expect(w.restarts()).toEqual([]);
    // The schedule's occurrence ended with its proposal: nobody waits at night, and the owner answers whenever they look.
    expect(w.liveAttempts()).toEqual([]);
    await w.decide(approval1, "approve");
    await w.drain();
    expect(w.restarts()).toEqual(["restarted demo-app"]);

    // The next occurrence proposes again: it needs a new approval and the first one buys it nothing.
    await w.command("automation.control", "run-2", { automationId, action: "runNow" });
    expect(await w.run()).toBe(true);
    const approval2 = await w.pendingApproval();
    expect(approval2.id).not.toBe(approval1.id);
    expect(w.restarts()).toHaveLength(1);
    await w.decide(approval2, "reject");
    await w.drain();
    expect(w.restarts()).toHaveLength(1);
    expect(w.permits().map((permit) => permit.state)).toEqual(["applied"]);
    expect(w.calls().map((call) => call.outcome)).toEqual(["applied", "declined"]);
  }, scaled(180_000));
});
