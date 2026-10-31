import { describe, expect, it } from "vitest";
import type { PlanTask } from "@brain/contracts";
import { assertPlanTasks } from "../../apps/governor/src/domain/work-plan";

const task = (id: string, dependsOn: string[] = []): PlanTask => ({ id, title: id, criteria: [`${id}-done`], dependsOn });

describe("plan dependency validation", () => {
  it("returns a deterministic topological order and accepts parallel branches", () => {
    expect(assertPlanTasks([task("review", ["fix"]), task("audit"), task("fix", ["audit"])])).toEqual(["audit", "fix", "review"]);
  });

  it("rejects cycles, unknown dependencies and duplicate IDs", () => {
    expect(() => assertPlanTasks([task("a", ["b"]), task("b", ["a"])])).toThrow(/cycle/i);
    expect(() => assertPlanTasks([task("a", ["missing"])])).toThrow(/unknown/i);
    expect(() => assertPlanTasks([task("a"), task("a")])).toThrow(/duplicate/i);
  });
});
