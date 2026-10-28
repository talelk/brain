import { describe, expect, it } from "vitest";
import { EventSpool, type SpoolEvent } from "../../apps/runner/src/spool";

// T20 packet acceptance (runner event path): the spool is bounded by count
// and bytes, sequences are monotonic with duplicate refusal, durable effect
// events are never dropped for telemetry, and drain order is stable.
const ev = (sequence: number, kind = "text", payload: unknown = { text: "x" }): SpoolEvent => ({ sequence, kind, payload });

describe("runner event spool bounds (T20)", () => {
  it("accepts in-order events and refuses duplicates/regressions", () => {
    const spool = new EventSpool(4, 1024);
    expect(spool.push(ev(1))).toBe("accepted");
    expect(spool.push(ev(2))).toBe("accepted");
    expect(spool.push(ev(2))).toBe("duplicate");
    expect(spool.push(ev(1))).toBe("duplicate");
    expect(spool.stats()).toMatchObject({ depth: 2, lastSequence: 2 });
  });

  it("backpressures telemetry at the count cap but lets effects evict telemetry", () => {
    const spool = new EventSpool(3, 1024 * 1024);
    expect(spool.push(ev(1))).toBe("accepted");
    expect(spool.push(ev(2))).toBe("accepted");
    expect(spool.push(ev(3))).toBe("accepted");
    expect(spool.push(ev(4))).toBe("backpressure");
    expect(spool.push(ev(4, "effect"))).toBe("accepted");
    const drained = spool.drain(10);
    expect(drained.map((e) => e.sequence)).toEqual([2, 3, 4]);
    expect(spool.stats().droppedTelemetry).toBe(1);
  });

  it("an all-effect spool backpressures rather than dropping evidence", () => {
    const spool = new EventSpool(2, 1024 * 1024);
    expect(spool.push(ev(1, "completion"))).toBe("accepted");
    expect(spool.push(ev(2, "error"))).toBe("accepted");
    expect(spool.push(ev(3, "effect"))).toBe("backpressure");
    expect(spool.drain(10).map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("byte cap is enforced independently of the count cap; drain frees budget", () => {
    const spool = new EventSpool(100, 120);
    expect(spool.push(ev(1, "text", { text: "y".repeat(40) }))).toBe("accepted");
    expect(spool.push(ev(2, "text", { text: "y".repeat(40) }))).toBe("backpressure");
    const drained = spool.drain(1);
    expect(drained).toHaveLength(1);
    expect(spool.push(ev(2, "text", { text: "y".repeat(40) }))).toBe("accepted");
    expect(spool.stats().depth).toBe(1);
  });
});
