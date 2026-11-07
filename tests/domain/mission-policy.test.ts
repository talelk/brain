import { describe, expect, it } from "vitest";
import type { PlanTask } from "@brain/contracts";
import { AUTONOMY_PRESETS, beyondPolicy, diffPlan, policyFor } from "../../apps/governor/src/domain/mission-policy";

const task = (id: string, dependsOn: string[] = [], extra: Partial<PlanTask> = {}): PlanTask => ({ id, title: id, criteria: [`${id}-done`], dependsOn, ...extra });

describe("mission plan diff and autonomy policy (T51, E113/E114)", () => {
  const confirmed = [task("a"), task("b", ["a"]), task("c", ["b"]), task("d")];

  it("finds the affected branch: changed tasks plus everything downstream", () => {
    const proposed = [task("a"), task("b", ["a"], { title: "b, revised" }), task("c", ["b"]), task("d")];
    const diff = diffPlan(confirmed, proposed, new Set());
    expect(diff.changed).toEqual(["b"]);
    expect(diff.affected).toEqual(["b", "c"]);
    expect(diff.operations).toEqual(["task.change"]);
  });

  it("classifies removals: optional tasks are task.remove, required tasks are backlog.drop", () => {
    const withOptional = [...confirmed, task("e", [], { optional: true })];
    expect(diffPlan(withOptional, confirmed, new Set()).operations).toEqual(["task.remove"]);
    expect(diffPlan(confirmed, confirmed.filter((entry) => entry.id !== "d"), new Set()).operations).toEqual(["backlog.drop"]);
  });

  it("separates reassignment from content changes", () => {
    const proposed = confirmed.map((entry) => entry.id === "d" ? { ...entry, assignment: { kind: "agent" as const, id: "claude", role: "specialist" as const } } : entry);
    const diff = diffPlan(confirmed, proposed, new Set());
    expect(diff.reassigned).toEqual(["d"]);
    expect(diff.operations).toEqual(["task.reassign"]);
  });

  it("rejects any version whose changes reach started work (E114)", () => {
    const proposed = [task("a", [], { title: "a, revised" }), task("b", ["a"]), task("c", ["b"]), task("d")];
    expect(() => diffPlan(confirmed, proposed, new Set(["a"]))).toThrow(/started work: a/);
    expect(() => diffPlan(confirmed, confirmed.filter((entry) => entry.id !== "d"), new Set(["d"]))).toThrow(/started work: d/);
    expect(diffPlan(confirmed, [...confirmed, task("e", ["a"])], new Set(["a"])).added).toEqual(["e"]);
  });

  it("presets expand to explicit operation lists; the policy gates what a coordinator may confirm (E113)", () => {
    expect(policyFor("standard", 1).operations).toEqual(AUTONOMY_PRESETS.standard);
    const drop = diffPlan(confirmed, confirmed.filter((entry) => entry.id !== "d"), new Set());
    expect(beyondPolicy(drop, policyFor("standard", 1))).toEqual(["backlog.drop"]);
    expect(beyondPolicy(drop, policyFor("autonomous", 1))).toEqual([]);
    expect(beyondPolicy(diffPlan(confirmed, [...confirmed, task("e")], new Set()), policyFor("supervised", 1))).toEqual(["task.add"]);
  });
});
