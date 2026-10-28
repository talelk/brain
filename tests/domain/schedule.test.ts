import { describe, expect, it } from "vitest";
import { cronFireId, dueCronFires, nextCronFire, parseCron } from "../../apps/governor/src/modules/workflows/cron";

// T19 packet acceptance (schedule half): cron fires are unique, timezone-
// correct across DST transitions, and misfire policy is explicit. Fair
// claim paging is covered in tests/integration (claim contention suites).
describe("cron scheduling (T19)", () => {
  it("parses strict 5-field expressions and rejects malformed ones", () => {
    expect(parseCron("30 2 * * *").minutes).toEqual(new Set([30]));
    expect(() => parseCron("61 * * * *")).toThrow();
    expect(() => parseCron("* * * *")).toThrow();
    expect(() => parseCron("0 0 * * 8")).toThrow();
  });

  it("spring-forward: a 02:30 daily job fires exactly once on the gap day", () => {
    const spec = parseCron("30 2 * * *");
    // America/New_York spring forward 2026-03-08: 02:30 local does not exist.
    const dayStart = Date.UTC(2026, 2, 7, 12, 0);
    const dayAfter = Date.UTC(2026, 2, 10, 12, 0);
    const fires: number[] = [];
    let cursor = dayStart;
    for (;;) {
      const next = nextCronFire(spec, "America/New_York", cursor);
      if (next === null || next > dayAfter) break;
      fires.push(next);
      cursor = next;
    }
    expect(new Set(fires).size).toBe(fires.length);
    expect(fires.length).toBe(3); // Mar 8, 9, 10 local — one each, no dup, no skip
    const ids = fires.map((f) => cronFireId("sched", f));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("fall-back: a 01:30 daily job fires once, not twice, in the repeated hour", () => {
    const spec = parseCron("30 1 * * *");
    // America/New_York fall back 2026-11-01: 01:30 local occurs twice.
    let cursor = Date.UTC(2026, 9, 31, 12, 0);
    const end = Date.UTC(2026, 10, 3, 12, 0);
    const fires: number[] = [];
    for (;;) {
      const next = nextCronFire(spec, "America/New_York", cursor);
      if (next === null || next > end) break;
      fires.push(next);
      cursor = next;
    }
    expect(fires.length).toBe(3); // Nov 1, 2, 3 — the ambiguous hour fires once
    expect(new Set(fires).size).toBe(3);
  });

  it("misfire policy: skip drops missed fires, once collapses to the latest", () => {
    const spec = parseCron("0 * * * *");
    const last = Date.UTC(2026, 0, 1, 0, 0);
    const now = Date.UTC(2026, 0, 1, 5, 30);
    expect(dueCronFires(spec, "UTC", last, now, "skip")).toEqual([]);
    const once = dueCronFires(spec, "UTC", last, now, "once");
    expect(once).toEqual([Date.UTC(2026, 0, 1, 5, 0)]);
  });
});
