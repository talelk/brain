import { describe, expect, it } from "vitest";
import { isCheckSession, preferredSession } from "../../apps/web/src/ui/console/session-kind";

const job = (jobId: string, group: string) => ({ jobId, placement: { group } }) as never;
const jobs = [job("job-work", "agents"), job("job-check", "evaluators")];

describe("which session is the work and which is its check (P5)", () => {
  it("a session on an evaluator job is a check; unknown or missing jobs count as work", () => {
    expect(isCheckSession({ jobId: "job-check" }, jobs)).toBe(true);
    expect(isCheckSession({ jobId: "job-work" }, jobs)).toBe(false);
    expect(isCheckSession({ jobId: "job-unknown" }, jobs)).toBe(false);
    expect(isCheckSession({}, jobs)).toBe(false);
  });

  it("a mission opens on its newest work, not on the check that reviewed it", () => {
    const newestFirst = [{ jobId: "job-check", id: "check" }, { jobId: "job-work", id: "work" }];
    expect(preferredSession(newestFirst, jobs)?.id).toBe("work");
    expect(preferredSession([{ jobId: "job-check", id: "check" }], jobs)?.id).toBe("check");
    expect(preferredSession([], jobs)).toBeUndefined();
  });
});

import { missionHref, sameTitleHints } from "../../apps/web/src/ui/mission-links";

describe("mission links and same-title hints (P6, P8)", () => {
  it("a link without a tab lets the mission pick the view that fits its step", () => {
    expect(missionHref("ws-a", "m-1")).toBe("/missions/m-1?w=ws-a");
    expect(missionHref("ws-a", "m-1", "plan")).toBe("/missions/m-1/plan?w=ws-a");
  });

  it("only missions that share a title get a start time", () => {
    const hints = sameTitleHints([
      { missionId: "a", title: "List the containers", createdAt: "2026-11-14T09:42:00Z" },
      { missionId: "b", title: "list the containers ", createdAt: "2026-11-14T10:05:00Z" },
      { missionId: "c", title: "Something else", createdAt: "2026-11-14T10:06:00Z" },
    ], (iso) => iso.slice(11, 16));
    expect([...hints]).toEqual([["a", "09:42"], ["b", "10:05"]]);
  });
});
