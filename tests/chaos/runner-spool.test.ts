import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DurableEventSpool } from "../../apps/runner/src/spool-durable";

// T20 durable events: an accepted event survives a process crash (fsync
// before push returns), unsent batches replay in order after a failed
// delivery, and the journal shrinks only on Governor acknowledgement.
describe("durable runner event spool (T20)", () => {
  it("fsyncs accepted events and replays them after a crash/reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-durable-spool-"));
    const path = join(dir, "spool", "att-1.jsonl");
    const spool = DurableEventSpool.load(path);
    expect(spool.push({ sequence: 1, kind: "progress", payload: { phase: "started" } })).toBe("accepted");
    expect(spool.push({ sequence: 2, kind: "effect", payload: { ref: "x" } })).toBe("accepted");
    // Simulate a crash: a fresh load of the same journal sees both events.
    const reloaded = DurableEventSpool.load(path);
    expect(reloaded.stats().depth).toBe(2);
    expect(reloaded.peek(10).map((e) => e.sequence)).toEqual([1, 2]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the journal until the batch is acknowledged; commit rewrites atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-durable-spool-"));
    const path = join(dir, "spool", "att-2.jsonl");
    const spool = DurableEventSpool.load(path);
    spool.push({ sequence: 1, kind: "progress", payload: "a" });
    spool.push({ sequence: 2, kind: "effect", payload: "b" });
    spool.push({ sequence: 3, kind: "progress", payload: "c" });
    // A failed POST changes nothing: peek returns the same batch again.
    const batch = spool.peek(10);
    expect(batch.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(spool.peek(10).map((e) => e.sequence)).toEqual([1, 2, 3]);
    spool.commit([1, 2]);
    expect(spool.peek(10).map((e) => e.sequence)).toEqual([3]);
    const onDisk = DurableEventSpool.load(path);
    expect(onDisk.peek(10).map((e) => e.sequence)).toEqual([3]);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    spool.discard();
    expect(existsSync(path)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects duplicates and backpressures telemetry when bounded", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-durable-spool-"));
    const spool = DurableEventSpool.load(join(dir, "s.jsonl"), 2, 8 * 1024 * 1024);
    expect(spool.push({ sequence: 1, kind: "progress", payload: "a" })).toBe("accepted");
    expect(spool.push({ sequence: 1, kind: "progress", payload: "a" })).toBe("duplicate");
    spool.push({ sequence: 2, kind: "progress", payload: "b" });
    expect(spool.push({ sequence: 3, kind: "progress", payload: "c" })).toBe("backpressure");
    // Effect events evict telemetry instead of being dropped.
    expect(spool.push({ sequence: 4, kind: "effect", payload: "d" })).toBe("accepted");
    expect(spool.peek(10).map((e) => e.sequence)).toEqual([2, 4]);
    expect(readFileSync(join(dir, "s.jsonl"), "utf8")).toContain("\"sequence\":4");
    rmSync(dir, { recursive: true, force: true });
  });
});
