import { COMMANDS } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import { tempBrain } from "../helpers";

/**
 * Every registered command has exactly one funnel handler, and every handler
 * serves a registered command. The human approval decision is the one handler
 * admitted by its own route under its own wire contract.
 */
describe("command registry coverage", () => {
  it("binds each registry command to exactly one handler", () => {
    const { brain } = tempBrain();
    try {
      const handled = brain.commands.commandTypes().sort();
      const declared = [...COMMANDS.keys(), "approval.decision"].sort();
      expect(handled).toEqual(declared);
    } finally {
      brain.close();
    }
  });
});
