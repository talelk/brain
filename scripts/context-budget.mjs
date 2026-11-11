// Repository context budget: reports and enforces what agent sessions load.
// Usage: node scripts/context-budget.mjs [--root <dir>] [--budget <file>] [--json]
// Tokens are estimated as bytes / bytesPerToken (budget file); real tokenizers differ.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function estimateTokens(bytes, bytesPerToken) {
  return Math.ceil(bytes / bytesPerToken);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function inside(root, p) {
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function skillDescription(file) {
  const text = readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return "";
  const d = /^description:\s*(.*)$/m.exec(m[1]);
  return d ? d[1].trim() : "";
}

/** Collect always-loaded and on-demand entries: { path, bytes, note? }. */
export function collect(root, budget) {
  const always = new Map();
  const external = [];
  const add = (rel, bytes, note) => always.set(rel, { path: rel, bytes, note });
  const addFile = (abs) => {
    if (!existsSync(abs) || !statSync(abs).isFile()) return;
    if (!inside(root, abs)) {
      if (!external.includes(abs)) external.push(abs);
      return;
    }
    add(relative(root, abs), statSync(abs).size);
  };

  for (const f of budget.always.files ?? []) addFile(resolve(root, f));

  // Files imported from AGENTS.md with `@path` lines.
  const agents = resolve(root, "AGENTS.md");
  if (existsSync(agents)) {
    for (const m of readFileSync(agents, "utf8").matchAll(/^@(\S+)\s*$/gm)) addFile(resolve(dirname(agents), m[1]));
  }
  // Instruction files named in opencode.json.
  const oc = resolve(root, "opencode.json");
  if (existsSync(oc)) {
    const cfg = JSON.parse(readFileSync(oc, "utf8"));
    for (const f of cfg.instructions ?? []) addFile(resolve(root, f));
  }
  // Skill descriptions are always loaded; the bodies are not.
  for (const dir of budget.always.skillDirs ?? []) {
    for (const f of walk(resolve(root, dir))) {
      if (!f.endsWith("SKILL.md")) continue;
      const d = skillDescription(f);
      add(`${relative(root, f)} (description)`, Buffer.byteLength(d, "utf8"), "skill description only");
    }
  }

  const onDemand = new Map();
  for (const spec of budget.onDemand.paths ?? []) {
    const abs = resolve(root, spec);
    if (!existsSync(abs)) continue;
    const files = statSync(abs).isDirectory() ? walk(abs) : [abs];
    for (const f of files) {
      const rel = relative(root, f);
      if (!always.has(rel)) onDemand.set(rel, { path: rel, bytes: statSync(f).size });
    }
  }
  return { always: [...always.values()], onDemand: [...onDemand.values()], external };
}

export function evaluate(root, budget) {
  const bpt = budget.bytesPerToken;
  const { always, onDemand, external } = collect(root, budget);
  const groups = [
    { name: "always-loaded", entries: always, ceiling: budget.always.ceilingTokens },
    { name: "on-demand", entries: onDemand, ceiling: budget.onDemand.ceilingTokens },
  ].map((g) => {
    const entries = g.entries
      .map((e) => ({ ...e, tokens: estimateTokens(e.bytes, bpt) }))
      .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
    return { ...g, entries, tokens: entries.reduce((n, e) => n + e.tokens, 0) };
  });
  const violations = [];
  for (const g of groups) {
    if (g.tokens > g.ceiling) {
      const top = g.entries[0];
      violations.push(
        `${g.name} group is ${g.tokens} estimated tokens, ceiling ${g.ceiling}; largest file ${top?.path ?? "-"} (${top?.tokens ?? 0} tokens)`,
      );
    }
    for (const e of g.entries) {
      const cap = budget.fileCeilingTokens?.[e.path];
      if (cap !== undefined && e.tokens > cap) violations.push(`${e.path} is ${e.tokens} estimated tokens, file ceiling ${cap}`);
    }
  }
  return { bytesPerToken: bpt, groups, external, violations };
}

export function render(result, top = 8) {
  const lines = [`Context budget (estimate: ${result.bytesPerToken} bytes per token)`];
  for (const g of result.groups) {
    lines.push("", `${g.name}: ${g.tokens} / ${g.ceiling} tokens, ${g.entries.length} files`);
    for (const e of g.entries.slice(0, top)) lines.push(`  ${String(e.tokens).padStart(7)}  ${e.path}`);
  }
  if (result.external.length) lines.push("", `Outside the repo, not counted: ${result.external.join(", ")}`);
  for (const v of result.violations) lines.push("", `OVER BUDGET: ${v}`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const root = resolve(opt("--root", process.cwd()));
  const budget = JSON.parse(readFileSync(resolve(root, opt("--budget", "docs/agents/context-budget.json")), "utf8"));
  const result = evaluate(root, budget);
  console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : render(result));
  process.exit(result.violations.length ? 1 : 0);
}
