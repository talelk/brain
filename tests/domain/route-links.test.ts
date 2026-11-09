import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTES } from "../../apps/web/src/routes/index.gen";

/**
 * Environment guard: every in-app link written as a literal in apps/web/src must resolve to a
 * route of the screen contract, so a renamed or removed screen cannot leave a dead link behind.
 * Only navigate(...), href=/href: and <Navigate href> arguments that are string or template
 * literals starting with "/" are checked; computed targets (missionHref(...), variables) are
 * out of scope, as are server paths (/v1/...) and downloads.
 */
const SRC = join(__dirname, "../../apps/web/src");
/** Non-contract routes declared by hand in app.tsx. */
const EXTRA_ROUTES = ["/", "/missions/:missionId"];
/** Server endpoints and static assets, not screens. */
const NON_SCREEN = [/^\/v1\//, /^\/assets\//, /^\/api\//];

const patterns = [...ROUTES.map((entry) => entry.route), ...EXTRA_ROUTES].map((route) => route.split("/").filter(Boolean));

function resolves(target: string): boolean {
  const path = target.split(/[?#]/u, 1)[0] ?? "";
  const segments = path.split("/").filter(Boolean);
  return patterns.some((pattern) => pattern.length === segments.length && pattern.every((part, index) => part.startsWith(":") || part === segments[index]));
}

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.tsx?$/u.test(name) && !name.endsWith(".gen.ts")) yield full;
  }
}

/** Matches `navigate(<literal>`, `href=<literal>`, `href={<literal>` and `href: <literal>`; ${...} becomes one wildcard segment. */
const LINK = /(?:navigate\(\s*|href\s*[=:]\s*\{?\s*)(`(?:[^`\\]|\\.)*`|"[^"\n]*"|'[^'\n]*')/gu;

function links(file: string): Array<{ line: number; target: string }> {
  const text = readFileSync(file, "utf8");
  const found: Array<{ line: number; target: string }> = [];
  for (const match of text.matchAll(LINK)) {
    const literal = match[1] ?? "";
    const raw = literal.slice(1, -1);
    if (!raw.startsWith("/") || raw.startsWith("//")) continue;
    const target = raw.replace(/\$\{[^}]*\}/gu, "x");
    if (NON_SCREEN.some((pattern) => pattern.test(target))) continue;
    found.push({ line: text.slice(0, match.index).split("\n").length, target });
  }
  return found;
}

describe("in-app links resolve to contract routes", () => {
  it("every literal navigate()/href target matches a route in routes/index.gen.ts", () => {
    const unresolved: string[] = [];
    let checked = 0;
    for (const file of sources(SRC)) {
      for (const link of links(file)) {
        checked++;
        if (!resolves(link.target)) unresolved.push(`${file.slice(SRC.length - "apps/web/src".length)}:${link.line} -> ${link.target}`);
      }
    }
    expect(checked, "the scan should find the app's literal links").toBeGreaterThan(25);
    expect(unresolved, "links that match no route").toEqual([]);
  });

  it("the matcher rejects a dead path and accepts parameterised ones", () => {
    expect(resolves("/overview")).toBe(false);
    expect(resolves("/w/x/overview")).toBe(false);
    expect(resolves("/w/x/missions?tab=1")).toBe(true);
    expect(resolves("/runs/x")).toBe(true);
    expect(resolves("/")).toBe(true);
  });
});
