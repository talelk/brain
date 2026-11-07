import { describe, expect, it } from "vitest";
import type { PlanTask } from "@brain/contracts";
import { AUTONOMY_PRESETS, assertTeamEligible, beyondPolicy, diffPlan, policyFor, teamOperations } from "../../apps/governor/src/domain/mission-policy";

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

  const agents = { builder: { tools: ["repo.read", "repo.write"], engines: ["pi", "claude"], maxMicroUsd: 500 }, reader: { tools: ["repo.read"], engines: ["pi"], maxMicroUsd: 0 } };
  const team = [{ memberId: "backend", role: "Backend engineer", agentId: "builder", engine: "claude" }, { memberId: "auditor", role: "Reviewer", agentId: "reader", engine: "pi" }];
  const assigned = (id: string, member: string, extra: Partial<PlanTask> = {}) => task(id, [], { assignment: { kind: "agent", id: member, role: "specialist" }, ...extra });

  it("checks eligibility mechanically: definition, engine, tools and spend cap; roles are labels", () => {
    expect(() => assertTeamEligible(team, [assigned("fix", "backend", { requiredTools: ["repo.write"], maxMicroUsd: 400 })], agents)).not.toThrow();
    expect(() => assertTeamEligible(team, [assigned("fix", "auditor", { requiredTools: ["repo.write"] })], agents)).toThrow(/missing tools repo.write/);
    expect(() => assertTeamEligible(team, [assigned("fix", "backend", { maxMicroUsd: 900 })], agents)).toThrow(/spend cap/);
    expect(() => assertTeamEligible(team, [assigned("fix", "stranger")], agents)).toThrow(/not on the mission team/);
    expect(() => assertTeamEligible([{ ...team[1]!, engine: "claude" }], [], agents)).toThrow(/does not run on engine claude/);
    expect(() => assertTeamEligible([{ ...team[0]!, agentId: "ghost" }], [], agents)).toThrow(/no published agent definition ghost/);
  });

  it("team growth is an existing-role or new-role operation", () => {
    expect(teamOperations(team, [...team, { memberId: "backend-2", role: "Backend engineer", agentId: "builder", engine: "pi" }])).toEqual(["member.addExistingRole"]);
    expect(teamOperations(team, [...team, { memberId: "designer", role: "Designer", agentId: "reader", engine: "pi" }])).toEqual(["member.addNewRole"]);
    expect(teamOperations(team, team.slice(0, 1))).toEqual([]);
  });
});
