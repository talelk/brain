import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkspace } from "../../apps/governor/src/workspace/load";

const packsDir = fileURLToPath(new URL("../../packs", import.meta.url));
const shipped = readdirSync(packsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

describe("the packs shipped with Brain", () => {
  it("are base, software-factory, sre and customer-operations", () => {
    expect(shipped.sort()).toEqual(["base", "customer-operations", "software-factory", "sre"]);
  });
  it.each(shipped)("%s loads and validates in a workspace that uses it", (name) => {
    const loaded = loadWorkspace(new Map([["brain.toml", new TextEncoder().encode(`name = "Uses ${name}"\npacks = ["${name}"]\n`)]]), packsDir);
    expect(loaded.problems).toEqual([]);
    expect(loaded.manifest?.packs).toContain(name);
    expect(Object.keys(loaded.manifest?.agents ?? {})).toEqual(expect.arrayContaining(["planner", "checker"]));
  });
});
