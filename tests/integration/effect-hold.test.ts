import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { EngineAdapter, EngineEvent, EngineSessionSpec } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { runAgentExecution } from "../../apps/runner/src/engines/run";
import { effectsWorld, type EffectsWorld } from "../support/effects-world";
import { scaled } from "../support/timing";

/** A model that proposes one tool call, then answers. */
function proposing(): EngineAdapter {
  let spec: EngineSessionSpec;
  const text = "done";
  return {
    id: "fixture", probe: async () => ({ id: "fixture", version: "1", adapterDigest: `sha256:${"0".repeat(64)}`, features: ["sessions"] }),
    start: async (value) => { spec = value; return { sessionId: "session-hold" }; },
    events: async function* () {
      void spec;
      yield { kind: "tool.proposed", payload: { proposalId: "p1", tool: { id: "host.restart", digest: `sha256:${"1".repeat(64)}` }, input: { container: "a" }, inputDigest: `sha256:${"2".repeat(64)}`, target: { targetId: "tool:host.restart", environmentId: "local", preconditionDigest: `sha256:${"3".repeat(64)}` } } } as unknown as EngineEvent;
      const bytes = new TextEncoder().encode(text);
      yield { kind: "text", payload: { text } } as EngineEvent;
      yield { kind: "session.stopped", payload: { reason: "completed", terminationConfirmed: true, output: { digest: sha256Digest(bytes), bytes: bytes.length } } } as EngineEvent;
    },
    toolResult: async () => undefined,
    cancel: vi.fn(async () => ({ terminationConfirmed: true })), dispose: vi.fn(async () => undefined),
    checkpoint: async () => { throw new Error("unsupported"); },
  };
}
const base = (executeTool: NonNullable<Parameters<typeof runAgentExecution>[0]["executeTool"]>) => ({
  engine: proposing(), attemptId: "att-hold", jobFence: 1, leaseId: "lease-hold", runnerId: "runner-hold", organizationId: "org-hold", workspaceId: "ws-hold", jobId: "job-hold",
  configDigest: `sha256:${"d".repeat(64)}`, task: "x", timeoutMs: 300, executeTool, emit: async () => undefined, signal: new AbortController().signal,
});
const slow = (ms: number, held: boolean) => async (_proposal: unknown, hold: <T>(work: Promise<T>) => Promise<T>) => {
  const wait = new Promise<void>((resolve) => setTimeout(resolve, ms));
  await (held ? hold(wait) : wait);
  return { proposalId: "p1", invocationId: "inv-hold-0001", receipt: {} as never, output: null };
};

describe("an approval's wait is not the agent's working time", () => {
  it("does not spend the execution deadline while a call waits for a person, and still enforces it on everything else", async () => {
    const held = await runAgentExecution(base(slow(900, true) as never));
    expect(held.ok).toBe(true);
    const notHeld = await runAgentExecution(base(slow(900, false) as never));
    expect(notHeld.ok).toBe(false);
    expect(JSON.stringify(notHeld.output)).toContain("deadline");
  });
});

let world: EffectsWorld | undefined;
afterAll(() => { if (world) rmSync(world.root, { recursive: true, force: true }); });

describe("a long wait for a person", () => {
  it("keeps the attempt alive (its lease is renewed) and asks nobody a second time", async () => {
    world = await effectsWorld();
    const w = world;
    await w.dispatch("long-wait");
    const running = w.run();
    const approval = await w.pendingApproval();
    const leaseAt = () => (w.store.control.prepare("SELECT lease_expires_at_ms AS at, state FROM job_attempts ORDER BY rowid DESC LIMIT 1").get() as { at: number; state: string });
    const before = leaseAt().at;
    // Longer than the runner's renewal interval (15 s): the lease moved on, the attempt still runs, and the job was neither restarted nor asked again.
    await new Promise((resolve) => setTimeout(resolve, 17_000));
    expect(leaseAt().at).toBeGreaterThan(before);
    expect(leaseAt().state).toBe("running");
    w.w.brain.jobProtocol.expireLeases();
    expect(w.attempts()).toHaveLength(1);
    expect((w.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get() as { n: number }).n).toBe(1);
    expect(w.restarts()).toEqual([]);
    await w.decide(approval, "approve");
    expect(await running).toBe(true);
    expect(w.restarts()).toEqual(["restarted demo-app"]);
  }, scaled(120_000));
});
