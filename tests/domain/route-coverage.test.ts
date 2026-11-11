import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Environment guard: every screen route in contracts/v1/ui-screen-contracts.json is opened by at
 * least one browser spec (a path literal in tests/browser/*.spec.ts that resolves to the route),
 * or is listed below with the reason it is reached another way. A new screen therefore cannot
 * ship without a spec; extend a spec or add a reasoned allowlist entry.
 */
const ROOT = join(__dirname, "../..");
const BROWSER = join(ROOT, "tests/browser");
/** Routes no spec opens by URL, with the reason. Keep this list short. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  "/accept-invitation/:id": "identity-administration.spec.ts opens the emailed invitation url taken from the outbox row",
  "/studio/:kind/:draftId": "studio.spec.ts lands on it by creating a draft, so the id is not known in advance",
};

const contract = JSON.parse(readFileSync(join(ROOT, "contracts/v1/ui-screen-contracts.json"), "utf8")) as { screens: Array<{ route: string }> };
const routes = contract.screens.map((screen) => screen.route);

/** Interpolations collapse to one wildcard character so a path literal is a plain run of segment characters. */
const WILD = "\u0000";
const specText = readdirSync(BROWSER).filter((name) => name.endsWith(".spec.ts")).map((name) => readFileSync(join(BROWSER, name), "utf8")).join("\n").replace(/\$\{[^}]*\}/gu, WILD);
/** Path literals: a quote or an interpolation, then /segment/segment... */
const PATH = new RegExp(`[${WILD}"'\`](\\/[\\w.~%/${WILD}-]+)`, "gu");
const visited = [...specText.matchAll(PATH)].map((match) => (match[1] ?? "").replaceAll(WILD, "x").split("/").filter(Boolean));

function covered(route: string): boolean {
  const pattern = route.split("/").filter(Boolean);
  return visited.some((segments) => pattern.length === segments.length && pattern.every((part, index) => part.startsWith(":") || part === segments[index]));
}

describe("route coverage by browser specs", () => {
  it("every contract route is visited by a spec or allowlisted with a reason", () => {
    expect(routes.length).toBeGreaterThan(20);
    const missing = routes.filter((route) => !covered(route) && !(route in ALLOWLIST));
    expect(missing, "routes no browser spec opens (add a spec visit or an ALLOWLIST reason)").toEqual([]);
  });

  it("allowlist entries are real routes with a reason and are not already covered", () => {
    for (const [route, reason] of Object.entries(ALLOWLIST)) {
      expect(routes, `${route} is not a contract route`).toContain(route);
      expect(reason.trim().length, `${route} needs a reason`).toBeGreaterThan(10);
      expect(covered(route), `${route} is covered by a spec; drop it from the allowlist`).toBe(false);
    }
  });
});
