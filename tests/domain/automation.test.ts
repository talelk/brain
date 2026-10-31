import { describe, expect, it } from "vitest";
import { occurrenceId, plannedInstants } from "../../apps/governor/src/modules/jobs/automation";

describe("automation planning (T52, E104)", () => {
  it("coalesces missed cron fires and records skip-policy history", () => {
    const row = { trigger_kind: "cron", cron: "* * * * *", timezone: "UTC", scheduled_at_ms: null, revision_created_at_ms: 1_700_000_040_000, misfire: "coalesce" } as const;
    const now = row.revision_created_at_ms + 5 * 60_000;
    expect(plannedInstants(row, null, now).dispatch).toEqual([1_700_000_340_000]);
    expect(plannedInstants({ ...row, misfire: "skip" }, null, now)).toEqual({ dispatch: [1_700_000_340_000], markSkipped: [1_700_000_100_000, 1_700_000_160_000, 1_700_000_220_000, 1_700_000_280_000] });
  });

  it("keeps occurrence identity stable and never schedules manual triggers", () => {
    expect(occurrenceId("auto-1", 2, 1_700_000_060_000)).toBe(occurrenceId("auto-1", 2, 1_700_000_060_000));
    expect(occurrenceId("auto-1", 2, 1_700_000_060_000)).not.toBe(occurrenceId("auto-1", 3, 1_700_000_060_000));
    expect(plannedInstants({ trigger_kind: "manual", cron: null, timezone: null, scheduled_at_ms: null, revision_created_at_ms: 0, misfire: "coalesce" }, null, 60_000)).toEqual({ dispatch: [], markSkipped: [] });
  });
});
