import { describe, expect, it } from "vitest";
import { checkOutcome, failureKey, takenLabel, waitingKey } from "../../apps/web/src/data/install-check";

const stopped = (reason: string) => [{ kind: "session.stopped", payload: { reason } }] as never;

describe("the installation check on Today", () => {
  it("reads the run's own state: succeeded passes, failed/partial/cancelled fail, anything else is still going", () => {
    expect(checkOutcome({ state: "verifying", runState: "succeeded" })).toBe("passed");
    expect(checkOutcome({ state: "running", runState: "running" })).toBe("running");
    expect(checkOutcome({ state: "queued" })).toBe("running");
    for (const state of ["failed", "partial", "cancelled"] as const) expect(checkOutcome({ state: "failed", runState: state })).toBe("failed");
    expect(checkOutcome({ state: "outcome_unknown" })).toBe("failed");
  });

  it("names a failure in plain words from the engine's stop reason", () => {
    expect(failureKey({ state: "failed", runState: "failed", engineEvents: stopped("timeout") })).toBe("today.check.fail.timeout");
    expect(failureKey({ state: "failed", runState: "failed", engineEvents: stopped("budget") })).toBe("today.check.fail.budget");
    expect(failureKey({ state: "failed", runState: "failed", engineEvents: stopped("error") })).toBe("today.check.fail.error");
    expect(failureKey({ state: "failed", runState: "failed", engineEvents: stopped("completed") })).toBe("today.check.fail.answer");
    expect(failureKey({ state: "cancelled", runState: "cancelled", engineEvents: [] })).toBe("today.check.fail.cancelled");
    expect(failureKey({ state: "failed", runState: "failed" })).toBe("today.check.fail.generic");
  });

  it("says why a check waits only when the run recorded a reason", () => {
    expect(waitingKey({ queueReasons: ["WAITING_FOR_RUNNER"] })).toBe("today.check.waiting.runner");
    expect(waitingKey({ queueReasons: ["INSUFFICIENT_CAPACITY"] })).toBe("today.check.waiting.busy");
    expect(waitingKey({ queueReasons: [] })).toBeUndefined();
  });

  it("rounds the time it took to whole seconds, at least one", () => {
    expect(takenLabel(400)).toEqual({ minutes: 0, seconds: 1 });
    expect(takenLabel(4_200)).toEqual({ minutes: 0, seconds: 4 });
    expect(takenLabel(65_000)).toEqual({ minutes: 1, seconds: 5 });
  });
});
