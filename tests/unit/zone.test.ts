import { describe, expect, it } from "vitest";
import { dayWindow, offsetAt } from "../../apps/governor/src/tasks/zone";

// docs/model.md, "The timeline and Insights": days are the caller's own, and a daylight-saving change inside the window is exact.
const HOUR = 3_600_000;

describe("the caller's days", () => {
  it("starts each local day at the zone's own midnight, with the offset in force at every instant", () => {
    // New York falls back on 1 November 2026 at 06:00 UTC: that day has 25 hours.
    const now = Date.UTC(2026, 10, 2, 12);
    const window = dayWindow("America/New_York", 3, now);
    expect(window.days).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(window.since).toBe(Date.UTC(2026, 9, 31, 4));
    expect(window.offsets).toEqual([{ from: Date.UTC(2026, 9, 31, 4), offset: -4 * HOUR }, { from: Date.UTC(2026, 10, 1, 6), offset: -5 * HOUR }]);
    expect(offsetAt("America/New_York", Date.UTC(2026, 10, 1, 5, 59, 59))).toBe(-4 * HOUR);
    expect(offsetAt("America/New_York", Date.UTC(2026, 10, 1, 6))).toBe(-5 * HOUR);
  });

  it("is one offset all along in a zone that does not change, and a whole number of days for a fixed one", () => {
    const window = dayWindow("Etc/GMT-3", 7, Date.UTC(2026, 10, 18, 22));
    expect(window.days.at(-1)).toBe("2026-11-19");
    expect(window.offsets).toEqual([{ from: window.since, offset: 3 * HOUR }]);
    expect(dayWindow("UTC", 90, Date.UTC(2026, 10, 18)).days).toHaveLength(90);
  });
});
