import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const openapi = JSON.parse(read("contracts/v1/openapi.json")) as {
  paths: Record<string, Record<string, { operationId: string; security: Array<Record<string, unknown>> }>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  "x-brain-commands": Array<{ type: string }>;
};

/** Every route the Governor registers, as `METHOD /path/{param}`; Better Auth owns /api/auth and the web fallback is not an API. */
function registered(): string[] {
  const found = new Set<string>();
  for (const m of read("apps/governor/src/http/app.ts").matchAll(/app\.(get|post|put|patch|delete)\(\s*"(\/[^"]*)"/g)) {
    const path = m[2]!.replace(/:([A-Za-z]+)/g, "{$1}");
    if (path.startsWith("/api/auth") || path.includes("*")) continue;
    found.add(`${m[1]!.toUpperCase()} ${path}`);
  }
  return [...found].sort();
}
function documented(): string[] {
  return Object.entries(openapi.paths).flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)).sort();
}

describe("OpenAPI is generated and covers every public route", () => {
  it("is exactly what the generator produces from the contract sources", () => {
    const run = spawnSync("python3", ["scripts/generate_openapi.py", "--check"], { cwd: ROOT, encoding: "utf8" });
    expect(run.stderr + run.stdout).toBe("");
    expect(run.status).toBe(0);
    expect(read("packages/contracts/src/openapi.json")).toBe(read("contracts/v1/openapi.json"));
  });

  it("documents every route the Governor registers and nothing it does not", () => {
    const app = registered();
    const doc = documented();
    expect(app.length).toBeGreaterThan(80);
    expect(app.filter((r) => !doc.includes(r)), "registered but missing from OpenAPI").toEqual([]);
    expect(doc.filter((r) => !app.includes(r)), "documented but not registered").toEqual([]);
  });

  it("has unique operation ids, resolvable references and known security schemes", () => {
    const ids = Object.values(openapi.paths).flatMap((ops) => Object.values(ops).map((op) => op.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    const refs = new Set([...JSON.stringify(openapi).matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!));
    expect([...refs].filter((name) => !(name in openapi.components.schemas))).toEqual([]);
    for (const ops of Object.values(openapi.paths)) for (const op of Object.values(ops)) for (const scheme of op.security) for (const name of Object.keys(scheme)) expect(openapi.components.securitySchemes).toHaveProperty(name);
  });

  it("lists every registry command with its scope", () => {
    const registry = JSON.parse(read("contracts/v1/registry.json")) as { commands: Array<{ type: string }> };
    expect(openapi["x-brain-commands"].map((c) => c.type)).toEqual(registry.commands.map((c) => c.type));
  });
});
