import { BRAIN_TOOL_COMMANDS, COMMANDS, SESSION_ADMITTED, SESSION_REFUSED, SESSION_REFUSED_COMMANDS, roleScopes } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import { tempBrain } from "../helpers";

/**
 * A session's machine principal runs only the commands behind its governed Brain tools (ADR 0032, 0042). Every command the Governor handles
 * must be classified admitted or refused for a session, so whoever adds a command has to decide, in the same change, whether a session may run it.
 */
describe("session command classification", () => {
  it("classifies every handled command exactly once, as admitted or refused", () => {
    const { brain } = tempBrain();
    try {
      const handled = brain.commands.commandTypes().sort();
      const refused = Object.values(SESSION_REFUSED).flat();
      expect(new Set(refused).size, "a command is refused under two reasons").toBe(refused.length);
      const classified = [...SESSION_ADMITTED, ...SESSION_REFUSED_COMMANDS];
      expect(classified.filter((type) => SESSION_ADMITTED.has(type) && SESSION_REFUSED_COMMANDS.has(type)), "a command is both admitted and refused").toEqual([]);
      const unclassified = handled.filter((type) => !SESSION_ADMITTED.has(type) && !SESSION_REFUSED_COMMANDS.has(type));
      expect(unclassified, "classify these commands in packages/contracts/src/session-commands.ts").toEqual([]);
      expect(classified.filter((type) => !handled.includes(type)), "classified commands the Governor does not handle").toEqual([]);
      expect([...COMMANDS.keys()].filter((type) => !SESSION_ADMITTED.has(type) && !SESSION_REFUSED_COMMANDS.has(type))).toEqual([]);
    } finally {
      brain.close();
    }
  });

  it("admits exactly the commands behind the governed Brain tools, each open to the agent kind", () => {
    expect([...SESSION_ADMITTED].sort()).toEqual(["handoff.submit", "mission.message.send", "plan.propose", "workItem.comment"]);
    expect([...SESSION_ADMITTED].sort()).toEqual(Object.values(BRAIN_TOOL_COMMANDS).sort());
    for (const type of SESSION_ADMITTED) expect(COMMANDS.get(type)?.actors, type).toContain("agent");
  });

  it("refuses every decision, verdict, closure, policy, brief, budget, confirmation and administration command", () => {
    for (const type of ["workItem.transition", "mission.proposeCompletion", "decision.accept", "mission.verdict.record", "mission.close", "plan.confirm", "plan.reject", "mission.policy.set", "mission.brief.edit", "mission.budget.set", "approval.decision", "approval.request", "workspace.update", "member.grant", "config.activate"]) {
      expect(SESSION_REFUSED_COMMANDS.has(type), type).toBe(true);
    }
  });

  it("gives the session role no scope of its own beyond reading and mission work, since the allowlist is what admits", () => {
    expect([...roleScopes("agent-session")].sort()).toEqual(["mission:write", "workspace:read"]);
  });
});
