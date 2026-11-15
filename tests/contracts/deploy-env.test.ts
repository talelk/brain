import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Story 99: a reference deployment sets only variables an app really reads. The read set is derived from the apps' own source, never
// listed by hand, so a renamed setting fails here instead of silently leaving a deployment on its defaults.
const root = process.cwd();
const { parse } = createRequire(join(root, "apps/governor/package.json"))("yaml") as { parse: (text: string) => unknown };

const SOURCE_ROOTS = ["apps/governor/src", "apps/runner/src", "apps/launcher/src", "apps/cli/src", "apps/web/src", "packages/contracts/src"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "dist" ? [] : sourceFiles(path);
    return /\.(ts|tsx|mjs|js)$/u.test(name) && !/\.generated\.ts$/u.test(name) ? [path] : [];
  });
}

/** Names the code reads: a BRAIN_* string literal (also behind a helper such as `positive("BRAIN_RUNNER_SLOTS")`), `process.env.X` or `env["X"]`. */
function variablesRead(sources: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const text of sources) {
    for (const match of text.matchAll(/["'`](BRAIN_[A-Z0-9_]+)["'`]/gu)) names.add(match[1]!);
    for (const match of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/gu)) names.add(match[1]!);
    for (const match of text.matchAll(/\benv\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/gu)) names.add(match[1]!);
  }
  return names;
}

/** The variables a compose file sets in a service's `environment:` (map or `KEY=value` list); interpolation names are not container variables. */
function environmentKeys(compose: string): string[] {
  const services = ((parse(compose) as { services?: Record<string, { environment?: Record<string, unknown> | string[] }> }).services) ?? {};
  return Object.values(services).flatMap((service) => {
    const environment = service.environment;
    if (!environment) return [];
    return Array.isArray(environment) ? environment.map((entry) => entry.split("=")[0]!) : Object.keys(environment);
  });
}

const unread = (compose: string, read: ReadonlySet<string>): string[] => environmentKeys(compose).filter((key) => !read.has(key));

const read = variablesRead(SOURCE_ROOTS.flatMap((dir) => sourceFiles(join(root, dir))).map((file) => readFileSync(file, "utf8")));
const referenceFiles = readdirSync(join(root, "deploy/reference")).filter((name) => /\.ya?ml$/u.test(name));

describe("reference deployment settings", () => {
  it("derives the read set from the apps, including settings read through a helper", () => {
    expect(referenceFiles.length).toBeGreaterThan(0);
    for (const name of ["BRAIN_RUNNER_SLOTS", "BRAIN_RUNNER_STATE_DIR", "BRAIN_BASE_URL", "BRAIN_DATA_DIR", "BRAIN_EGRESS_GRANTS_DIR", "NODE_ENV", "PORT"]) expect(read.has(name), name).toBe(true);
  });

  it("flags a setting that no app reads (the two names the reference runner once carried)", () => {
    const stale = "services:\n  supervisor:\n    environment:\n      BRAIN_RUNNER_CREDENTIAL_FILE: /run/secrets/runner_credential\n      BRAIN_SLOT_LIMIT: '1'\n      BRAIN_RUNNER_SLOTS: '1'\n";
    expect(unread(stale, read)).toEqual(["BRAIN_RUNNER_CREDENTIAL_FILE", "BRAIN_SLOT_LIMIT"]);
    expect(unread("services:\n  a:\n    environment:\n      - BRAIN_SLOT_LIMIT=1\n      - BRAIN_RUNNER_SLOTS=1\n", read)).toEqual(["BRAIN_SLOT_LIMIT"]);
  });

  for (const file of referenceFiles) {
    it(`${file} sets only variables an app reads`, () => {
      expect(unread(readFileSync(join(root, "deploy/reference", file), "utf8"), read)).toEqual([]);
    });
  }

  it("the runner's credential is kept where the runner reads it, in its state directory", () => {
    const compose = readFileSync(join(root, "deploy/reference/compose.runner.yaml"), "utf8");
    expect(environmentKeys(compose)).toContain("BRAIN_RUNNER_STATE_DIR");
    expect(compose).toMatch(/runner_state:\/state/u);
    expect(readFileSync(join(root, "apps/runner/src/supervisor.ts"), "utf8")).toContain('join(cfg.stateDir, "credential.txt")');
  });
});
