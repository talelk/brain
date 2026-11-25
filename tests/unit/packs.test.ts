import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkspace } from "../../apps/governor/src/workspace/load";

const packsDir = fileURLToPath(new URL("../../packs", import.meta.url));
const shipped = readdirSync(packsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

describe("the packs shipped with Brain", () => {
  it("are base, software-factory, sre, customer-operations, platform, presales, data-engineering, frontend-qa, security, modernization and ai-factory", () => {
    expect(shipped.sort()).toEqual(["ai-factory", "base", "customer-operations", "data-engineering", "frontend-qa", "modernization", "platform", "presales", "security", "software-factory", "sre"]);
  });
  it.each(shipped)("%s loads and validates in a workspace that uses it", (name) => {
    const loaded = loadWorkspace(new Map([["brain.toml", new TextEncoder().encode(`name = "Uses ${name}"\npacks = ["${name}"]\n${name === "platform" ? "platform = \"admin\"\n" : ""}`)]]), packsDir);
    expect(loaded.problems).toEqual([]);
    expect(loaded.manifest?.packs).toContain(name);
    expect(Object.keys(loaded.manifest?.agents ?? {})).toEqual(expect.arrayContaining(["planner", "checker"]));
  });
  it.each(shipped)("%s is written for people in French and Arabic as well (docs/model.md, Translations)", (name) => {
    const loaded = loadWorkspace(new Map([["brain.toml", new TextEncoder().encode(`name = "Uses ${name}"\npacks = ["${name}"]\n${name === "platform" ? "platform = \"admin\"\n" : ""}`)]]), packsDir);
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

  describe("keep the shape in packs/README.md, The shape of a pack", () => {
    const read = (path: string): string => readFileSync(`${packsDir}/${path}`, "utf8");
    const dirs = (path: string): string[] => (existsSync(`${packsDir}/${path}`) ? readdirSync(`${packsDir}/${path}`, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
    const plays = shipped.flatMap((pack) => readdirSync(`${packsDir}/${pack}/plays`).filter((f) => f.endsWith(".toml")).map((f) => ({ pack, file: f, play: parseToml(read(`${pack}/plays/${f}`)) as { trigger?: { schedule?: string }; step?: { review_by?: string; requires?: string[] }[] } })));
    const agents = shipped.flatMap((pack) => dirs(`${pack}/agents`).map((name) => ({ pack, name, spec: parseToml(read(`${pack}/agents/${name}/agent.toml`)) as { native?: string; tools?: string[]; limits?: { spend_usd?: number } } })));
    const tools = shipped.flatMap((pack) => dirs(`${pack}/tools`).map((name) => ({ pack, name, spec: parseToml(read(`${pack}/tools/${name}/tool.toml`)) as { effect: string } })));
    const critics = new Set(["checker", ...plays.flatMap((p) => (p.play.step ?? []).map((s) => s.review_by ?? "")).filter(Boolean)]);

    it("a critic reads only, never changes anything, answers in the verdict format, and costs at most 0.75 a round", () => {
      const bad: string[] = [];
      for (const { pack, name, spec } of agents.filter((a) => critics.has(a.name))) {
        if (spec.native === "all") bad.push(`${name} has native = "all"`);
        for (const tool of spec.tools ?? []) if (tools.find((t) => t.name === tool && t.spec.effect !== "read")) bad.push(`${name} has the ${tool} tool, which changes something`);
        if (!read(`${pack}/agents/${name}/prompt.md`).includes('{"pass"')) bad.push(`${name}'s prompt has no {"pass", "score", "findings"} answer`);
        if ((spec.limits?.spend_usd ?? 0) > 0.75) bad.push(`${name} may spend more than 0.75`);
      }
      expect(bad).toEqual([]);
    });
    it("every agent has a spend limit of at most 2.00 with all native tools and 1.00 without, and no agent of a pack sets model", () => {
      expect(agents.filter((a) => !((a.spec.limits?.spend_usd ?? 0) > 0 && (a.spec.limits?.spend_usd ?? 0) <= (a.spec.native === "all" ? 2 : 1))).map((a) => a.name)).toEqual([]);
      expect(agents.filter((a) => "model" in a.spec).map((a) => a.name)).toEqual([]);
    });
    it("an agent with a privileged tool is an operator: no native tools, and at most 0.75", () => {
      const operators = agents.filter((a) => (a.spec.tools ?? []).some((tool) => tools.some((t) => t.name === tool && t.spec.effect === "privileged")));
      expect(operators.filter((a) => (a.spec.native ?? "none") !== "none" || (a.spec.limits?.spend_usd ?? 0) > 0.75).map((a) => a.name)).toEqual([]);
    });
    it("no pack ships a memory entry that satisfies a step's requires: only the workspace's own entries can", () => {
      const entries = shipped.flatMap((pack) => (dirs(pack).includes("memory") ? readdirSync(`${packsDir}/${pack}/memory`).map((f) => f.replace(/(\.(fr|ar))?\.md$/u, "")) : []));
      const patterns = plays.flatMap((p) => (p.play.step ?? []).flatMap((s) => s.requires ?? []));
      expect(patterns.filter((pattern) => entries.some((entry) => new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`, "u").test(entry)))).toEqual([]);
    });
    it("a tool that runs a script has run.sh and test.sh, and a tool name is <system>.<verb>", () => {
      const bad: string[] = [];
      for (const { pack, name } of tools) {
        if (!/^[a-z0-9-]+\.[a-z0-9-]+$/u.test(name)) bad.push(`${name} is not <system>.<verb>`);
        const dir = `${packsDir}/${pack}/tools/${name}`;
        if (existsSync(`${dir}/run.sh`) !== existsSync(`${dir}/test.sh`)) bad.push(`${name} needs run.sh and test.sh together`);
      }
      expect(bad).toEqual([]);
    });
    it("no two scheduled Plays start at the same time, and a memory entry that is a model to copy is named template-*", () => {
      const times = plays.flatMap((p) => (p.play.trigger?.schedule ? [p.play.trigger.schedule] : []));
      expect(times.filter((t, i) => times.indexOf(t) !== i)).toEqual([]);
      const copied = shipped.flatMap((pack) => dirs(pack).includes("memory") ? readdirSync(`${packsDir}/${pack}/memory`).filter((f) => /^(?!template-)[a-z0-9-]*(template|example)[a-z0-9-]*\.md$/u.test(f)) : []);
      expect(copied).toEqual([]);
    });
  });
});
