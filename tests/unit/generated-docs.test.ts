import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT } from "../../packages/contracts/src/env";
import { generatedDocs } from "../../scripts/generated-docs";

/** Pages written from the code, and the one list of environment variables (docs/architecture.md section 1). */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const sources = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(folder, entry.name)) : /\.(?:ts|mjs)$/u.test(entry.name) ? [join(folder, entry.name)] : []));
const code = [...["governor", "runner", "launcher", "store", "mcp"].flatMap((app) => sources(join(ROOT, "apps", app, "src"))), join(ROOT, "scripts", "brain.ts")].map((path) => readFileSync(path, "utf8")).join("\n");
const declared = new Set(ENVIRONMENT.flatMap((group) => group.vars.map((one) => one.name)));

describe("the pages written from the code", () => {
  it("are up to date (pnpm docs:gen writes them)", () => {
    for (const [path, text] of Object.entries(generatedDocs())) expect(readFileSync(join(ROOT, path), "utf8"), path).toBe(text);
  });
});

describe("the environment", () => {
  it("lists every variable the code names, once", () => {
    // A name that ends in `_` is the start of one made at run time; BRAIN_TOOLS is a constant of the code, not a variable.
    const named = new Set([...code.matchAll(/\b(?:BRAIN_[A-Z0-9_]*[A-Z0-9]|VM_(?:URL|USER|PASS)|LOG_LEVEL)\b(?!_)/gu)].map((match) => match[0]).filter((name) => name !== "BRAIN_TOOLS"));
    expect([...named].filter((name) => !declared.has(name))).toEqual([]);
    expect(ENVIRONMENT.flatMap((group) => group.vars).length).toBe(declared.size);
  });

  it("lists no variable that nothing reads", () => {
    expect([...declared].filter((name) => !code.includes(name.replace("<NAME>", "")))).toEqual([]);
  });
});
