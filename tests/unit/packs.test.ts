import type { SnapshotManifest } from "@brain/contracts";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkspace } from "../../apps/governor/src/workspace/load";
import { packShapeProblems } from "../../apps/governor/src/workspace/pack-shape";

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

  const manifestUsing = (name: string) => loadWorkspace(new Map([["brain.toml", new TextEncoder().encode(`name = "Uses ${name}"\npacks = ["${name}"]\n${name === "platform" ? "platform = \"admin\"\n" : ""}`)]]), packsDir).manifest as SnapshotManifest;

  it.each(shipped)("%s keeps the shape of a pack (packs/README.md)", (name) => {
    expect(packShapeProblems(manifestUsing(name), name)).toEqual([]);
  });
  it("no two scheduled Plays of different packs start at the same time", () => {
    const times = shipped.flatMap((pack) => Object.values(manifestUsing(pack).plays).filter((play) => play.source === pack && play.trigger?.schedule).map((play) => play.trigger?.schedule as string));
    expect(times.filter((time, index) => times.indexOf(time) !== index)).toEqual([]);
  });
});

describe("the shape of a pack", () => {
  const shape = (files: Record<string, string>) => {
    const loaded = loadWorkspace(new Map(Object.entries({ "brain.toml": 'name = "Draft"\n', ...files }).map(([path, content]) => [path, new TextEncoder().encode(content)])), packsDir);
    expect(loaded.problems).toEqual([]);
    return packShapeProblems(loaded.manifest as SnapshotManifest, "workspace").map((problem) => `${problem.path}: ${problem.message}`);
  };
  const agent = (name: string, toml: string) => ({ [`agents/${name}/agent.toml`]: `description = "${name}."\n${toml}`, [`agents/${name}/prompt.md`]: "Work.\n" });

  it("holds agents to their spend, their critics to reading and operators to approval", () => {
    expect(shape({
      ...agent("free", ""), ...agent("pinned", 'model = "main"\n[limits]\nspend_usd = 0.5\n'), ...agent("reviewer", 'native = "all"\n[limits]\nspend_usd = 1.5\n'), ...agent("maker", "[limits]\nspend_usd = 0.5\n"),
      "brain.toml": 'name = "Draft"\n[[model]]\nname = "main"\nprovider = "anthropic"\nurl = "https://m.example"\nmodel = "m"\n',
      "plays/job.toml": 'title = "Job"\n[[step]]\nid = "do"\nagent = "maker"\ngoal = "Do."\nreview_by = "reviewer"\n',
    })).toEqual([
      expect.stringContaining("agents/free/agent.toml: an agent of a pack has a spend limit"),
      expect.stringContaining("agents/pinned/agent.toml: an agent of a pack sets no model"),
      expect.stringContaining('agents/reviewer/agent.toml: a critic changes nothing: it has no native = "all"'),
      expect.stringContaining("agents/reviewer/agent.toml: a critic costs at most 0.75"),
    ]);
  });

  it("holds tools to their names and proofs, and memory and schedules to theirs", () => {
    const play = 'title = "P"\n[trigger]\nschedule = "0 6 * * 1"\n[[step]]\nid = "do"\nagent = "dev"\ngoal = "Do."\nrequires = ["screens-*"]\n';
    expect(shape({
      ...agent("dev", "[limits]\nspend_usd = 0.5\n"), "tools/deploy.app.now/tool.toml": 'description = "x"\neffect = "read"\n', "tools/deploy.app.now/run.sh": "echo\n",
      "memory/screens-example.md": "---\ntype: Template\n---\n\nCopy me.\n", "plays/one.toml": play, "plays/two.toml": play,
    })).toEqual([
      expect.stringContaining("a tool of a pack is named <system>.<verb>"),
      expect.stringContaining("run.sh and test.sh together"),
      expect.stringContaining("is named template-"),
      expect.stringContaining('requires "screens-*"'),
      expect.stringContaining('requires "screens-*"'),
      expect.stringContaining("starts at the same time as one"),
    ]);
  });
});
