import { BrainFile, PlayFile, ToolFile } from "@brain/contracts";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { brainOf, brainToml, playToml, toolToml } from "../../apps/web/src/lib/files";

/** Editing in the app writes the file (docs/model.md): what a form saves reads back as what it was given, left alone settings included. */
describe("a file saved by a form says what the file said", () => {
  it("brain.toml keeps a project read only and without network, and the checkpoint", () => {
    const brain = BrainFile.parse({
      name: "W", limits: { checkpoint: "6h", checkpoint_timeout: "2h" },
      project: [{ name: "closed", repo: "https://x.test/a.git", access: "read", network: [] }, { name: "open", repo: "https://x.test/b.git" }, { name: "listed", repo: "https://x.test/c.git", network: ["registry.npmjs.org"] }],
    });
    const saved = brainToml(brainOf({ ...brain, models: brain.model, projects: brain.project, github: null, teams: null, packs: [] } as never));
    expect(BrainFile.parse(parse(saved))).toEqual(brain);
  });
  it("a tool keeps no network", () => {
    for (const network of [[], ["*"], ["api.github.com"]]) {
      const tool = ToolFile.parse({ description: "x", effect: "read", network });
      expect(ToolFile.parse(parse(toolToml(tool)))).toEqual(tool);
    }
  });
  it("a Play keeps its checkpoint, what a step requires and its rounds", () => {
    for (const max_rounds of [1, 2, 3]) {
      const play = PlayFile.parse({ title: "P", checkpoint: "6h", step: [{ id: "a", agent: "x", goal: "g", max_rounds, requires: ["notes-*"] }] });
      expect(PlayFile.parse(parse(playToml(play)))).toEqual(play);
    }
  });
});
