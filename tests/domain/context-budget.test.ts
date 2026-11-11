import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { evaluate } from "../../scripts/context-budget.mjs";

function fixture() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ctx-budget-"));
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("AGENTS.md", `# Rules\n@docs/imported.md\n${"a".repeat(400)}`);
  put("docs/imported.md", "b".repeat(800));
  put("opencode.json", JSON.stringify({ instructions: ["docs/prompt.md", "/nonexistent/elsewhere.md"] }));
  put("docs/prompt.md", "c".repeat(1200));
  put(".claude/skills/demo/SKILL.md", `---\nname: demo\ndescription: ${"d".repeat(40)}\n---\n${"body ".repeat(1000)}`);
  put("GLOSSARY.md", "g".repeat(4000));
  put("docs/implementation/big.md", "i".repeat(40_000));
  const budget = {
    bytesPerToken: 4,
    always: { ceilingTokens: 1000, files: ["AGENTS.md"], skillDirs: [".claude/skills"] },
    onDemand: { ceilingTokens: 20_000, paths: ["GLOSSARY.md", "docs/implementation"] },
    fileCeilingTokens: {},
  };
  put("budget.json", JSON.stringify(budget));
  return { root, budget, put };
}

describe("context budget", () => {
  it("separates always-loaded from on-demand and counts only skill descriptions", () => {
    const { root, budget } = fixture();
    const r = evaluate(root, budget);
    const [always, onDemand] = r.groups;
    expect(always.entries.map((e: { path: string }) => e.path).sort()).toEqual([
      ".claude/skills/demo/SKILL.md (description)",
      "AGENTS.md",
      "docs/imported.md",
      "docs/prompt.md",
    ]);
    // 10 (skill) + (8+400+... AGENTS.md) bytes: imported file counted once, in the always group.
    expect(always.entries.find((e: { path: string }) => e.path.startsWith(".claude"))?.bytes).toBe(40);
    expect(onDemand.entries.map((e: { path: string }) => e.path)).toEqual(["docs/implementation/big.md", "GLOSSARY.md"]);
    expect(onDemand.tokens).toBe(11_000);
    expect(r.external).toEqual([]);
    expect(r.violations).toEqual([]);
  });

  it("exits non-zero naming the offending file when a ceiling is exceeded", () => {
    const { root, put } = fixture();
    put("docs/prompt.md", "c".repeat(9000));
    const run = spawnSync("node", [join(process.cwd(), "scripts/context-budget.mjs"), "--root", root, "--budget", "budget.json"], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("OVER BUDGET: always-loaded");
    expect(run.stdout).toContain("docs/prompt.md");
  });

  it("enforces a per-file ceiling and passes the repository's own budget", () => {
    const { root, budget } = fixture();
    const r = evaluate(root, { ...budget, fileCeilingTokens: { "GLOSSARY.md": 100 } });
    expect(r.violations).toEqual(["GLOSSARY.md is 1000 estimated tokens, file ceiling 100"]);
    const own = spawnSync("node", ["scripts/context-budget.mjs"], { encoding: "utf8" });
    expect(own.status, own.stdout).toBe(0);
  });
});
