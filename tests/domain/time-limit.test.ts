import { describe, expect, it } from "vitest";
import { unionMs, limitChangeNote } from "../../apps/governor/src/modules/missions/budget";
import { planWallLimit, PLAN_TIME_FLOOR_MS } from "../../apps/governor/src/modules/missions/estimate";

const MIN = 60_000;

describe("working time is the union of attempt intervals (ADR 0016)", () => {
  it("counts parallel attempts once, gaps as zero and ignores empty intervals", () => {
    expect(unionMs([])).toBe(0);
    expect(unionMs([[0, 10 * MIN], [5 * MIN, 15 * MIN]])).toBe(15 * MIN);
    expect(unionMs([[0, 10 * MIN], [60 * MIN, 70 * MIN]])).toBe(20 * MIN);
    expect(unionMs([[0, 40 * MIN], [10 * MIN, 20 * MIN], [30 * MIN, 50 * MIN]])).toBe(50 * MIN);
    expect(unionMs([[5, 5], [9, 3]])).toBe(0);
  });
});

describe("the time limit follows the plan (ADR 0016)", () => {
  const tasks = (minutes: number[]) => minutes.map((estimatedMinutes) => ({ estimatedMinutes }));

  it("raises a default limit to max(current, estimate x 3, 2 h) and never lowers it", () => {
    expect(planWallLimit(30 * MIN, false, tasks([85]))).toEqual({ limitMs: 255 * MIN, belowEstimate: false, raised: true });
    expect(planWallLimit(30 * MIN, false, tasks([10, 8]))).toEqual({ limitMs: PLAN_TIME_FLOOR_MS, belowEstimate: false, raised: true });
    expect(planWallLimit(30 * MIN, false, [{}])).toMatchObject({ limitMs: PLAN_TIME_FLOOR_MS });
    expect(planWallLimit(600 * MIN, false, tasks([85]))).toEqual({ limitMs: 600 * MIN, belowEstimate: false, raised: false });
  });

  it("keeps a limit a person named and warns when it is below the estimate", () => {
    expect(planWallLimit(30 * MIN, true, tasks([85]))).toEqual({ limitMs: 30 * MIN, belowEstimate: true, raised: false });
    expect(planWallLimit(3 * 60 * MIN, true, tasks([85]))).toMatchObject({ belowEstimate: false, raised: false });
  });

  it("does not invent a limit for a mission that has none", () => {
    expect(planWallLimit(null, false, tasks([85]))).toEqual({ limitMs: null, belowEstimate: false, raised: false });
  });
});

describe("limit change notes", () => {
  it("say which limit moved and from what to what", () => {
    expect(limitChangeNote({ budget_wall_ms: 30 * MIN, budget_micro_usd: 2_000_000, budget_tokens: null }, { maxWallClockMs: 60 * MIN, maxMicroUsd: 3_000_000 }))
      .toBe("Limits changed: time limit 30 min to 1 h; dollar budget $2 to $3");
    expect(limitChangeNote({ budget_wall_ms: null, budget_micro_usd: null, budget_tokens: null }, {})).toBe("Limits saved unchanged");
  });
});
