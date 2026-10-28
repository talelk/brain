// Boundary checker: enforces module-layout.json isolation rules with zero deps.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const failures = [];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function importsOf(file) {
  const text = readFileSync(file, "utf8");
  const specs = [];
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text)) !== null) specs.push(m[1]);
  return specs;
}

const roots = [
  { dir: "apps/governor/src", name: "governor" },
  { dir: "apps/runner/src", name: "runner" },
  { dir: "apps/launcher/src", name: "launcher" },
  { dir: "apps/web/src", name: "web" },
  { dir: "apps/cli/src", name: "cli" },
  { dir: "packages/contracts/src", name: "contracts" },
];

for (const { dir, name } of roots) {
  for (const file of walk(join(root, dir))) {
    const rel = relative(root, file);
    for (const spec of importsOf(file)) {
      if (name === "contracts" && (spec.includes("hono") || spec.includes("better-sqlite3") || spec.includes("@mastra"))) {
        failures.push(`${rel}: contracts must not import vendor/DB (${spec})`);
      }
      if (name === "web" && (spec.includes("better-sqlite3") || spec.includes("@brain/governor") || spec.startsWith("@newui/") || spec.includes("/internal") || spec === "@talelk/newui-data/resource")) {
        failures.push(`${rel}: web forbidden import (${spec})`);
      }
      if (name === "runner" && spec.includes("better-sqlite3")) {
        failures.push(`${rel}: runner must not access central DB directly (${spec})`);
      }
      // Cross-app relative imports are forbidden; use @brain/contracts only.
      if (spec.startsWith("..") && spec.includes("apps/")) {
        failures.push(`${rel}: cross-app relative import (${spec})`);
      }
      if (spec.startsWith("@brain/") && !spec.startsWith("@brain/contracts")) {
        failures.push(`${rel}: only @brain/contracts is shared (${spec})`);
      }
    }
    // Governor cross-module private imports: must go through modules/<name>/index
    if (name === "governor") {
      const text = readFileSync(file, "utf8");
      const re2 = /from\s+["'](\.{1,2}\/[^"']+)["']/g;
      let mm;
      while ((mm = re2.exec(text)) !== null) {
        const spec = mm[1];
        const modMatch = spec.match(/modules\/([a-z-]+)\/(.+)$/);
        if (modMatch) {
          const rest = modMatch[2];
          if (rest !== "index" && rest !== "index.js" && !file.includes(`/modules/${modMatch[1]}/`)) {
            failures.push(`${rel}: cross-module import must use index (${spec})`);
          }
        }
      }
      // Pure domain: no IO/vendor
      if (rel.includes("src/domain/")) {
        for (const spec of importsOf(file)) {
          if (/hono|better-sqlite3|@mastra|node:fs|node:http|drizzle/.test(spec)) {
            failures.push(`${rel}: domain must stay pure (${spec})`);
          }
        }
      }
    }
  }
}

if (failures.length) {
  console.error(`BOUNDARY FAILURES (${failures.length}):`);
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log("boundaries OK");
