import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkspace } from "../../apps/governor/src/workspace/load";

const packsDir = fileURLToPath(new URL("../../packs", import.meta.url));
const shipped = readdirSync(packsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

describe("the packs shipped with Brain", () => {
  it("are base, software-factory, sre, customer-operations and platform", () => {
    expect(shipped.sort()).toEqual(["base", "customer-operations", "platform", "software-factory", "sre"]);
  });
  it.each(shipped)("%s loads and validates in a workspace that uses it", (name) => {
    const loaded = loadWorkspace(new Map([["brain.toml", new TextEncoder().encode(`name = "Uses ${name}"\npacks = ["${name}"]\n${name === "platform" ? "platform = true\n" : ""}`)]]), packsDir);
    expect(loaded.problems).toEqual([]);
    expect(loaded.manifest?.packs).toContain(name);
    expect(Object.keys(loaded.manifest?.agents ?? {})).toEqual(expect.arrayContaining(["planner", "checker"]));
  });
  it.each(shipped)("%s is written for people in French and Arabic as well (docs/model.md, Translations)", (name) => {
    const loaded = loadWorkspace(new Map([["brain.toml", new TextEncoder().encode(`name = "Uses ${name}"\npacks = ["${name}"]\n${name === "platform" ? "platform = true\n" : ""}`)]]), packsDir);
    const manifest = loaded.manifest;
    const own = (source: string): boolean => source === name;
    const missing: string[] = [];
    for (const lang of ["fr", "ar"] as const) {
      for (const [id, agent] of Object.entries(manifest?.agents ?? {})) if (own(agent.source) && !agent.translations?.[lang]?.description) missing.push(`agent ${id} ${lang}`);
      for (const [id, tool] of Object.entries(manifest?.tools ?? {})) {
        if (!own(tool.source)) continue;
        if (!tool.translations?.[lang]?.description) missing.push(`tool ${id} ${lang}`);
        for (const [input, spec] of Object.entries(tool.inputs)) if (spec.description && !tool.translations?.[lang]?.inputs?.[input]) missing.push(`tool ${id} input ${input} ${lang}`);
      }
      for (const [id, play] of Object.entries(manifest?.plays ?? {})) {
        if (!own(play.source)) continue;
        if (!play.translations?.[lang]?.title || !play.translations[lang]?.description) missing.push(`play ${id} ${lang}`);
        for (const [input, spec] of Object.entries(play.inputs)) if (spec.description && !play.translations?.[lang]?.inputs?.[input]) missing.push(`play ${id} input ${input} ${lang}`);
      }
      for (const entry of manifest?.memory ?? []) if (own(entry.source) && !entry.titles[lang]) missing.push(`memory ${entry.name} ${lang}`);
    }
    expect(missing).toEqual([]);
  });
});
