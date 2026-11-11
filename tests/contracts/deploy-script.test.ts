import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(join(process.cwd(), "scripts/deploy-demo.sh"), "utf8");

describe("deploy-demo.sh safety order", () => {
  it("is valid bash", () => {
    execFileSync("bash", ["-n", "scripts/deploy-demo.sh"]);
  });

  it("repairs a copy of the live databases before syncing, building or stopping anything", () => {
    const precheck = script.indexOf("pnpm exec tsx scripts/repair-live-schema.ts");
    expect(precheck).toBeGreaterThan(-1);
    for (const later of ['echo "==> Syncing source', "docker compose build governor", "docker compose stop governor"]) {
      expect(script.indexOf(later), later).toBeGreaterThan(precheck);
    }
    expect(script).toContain("old container still running");
  });

  it("prints the governor's first error lines when it does not become ready, and restarts the old container on a failed roll", () => {
    expect(script).toMatch(/First error lines from its log[\s\S]*docker compose logs --no-color/u);
    expect(script).toContain("docker compose start governor");
  });

  it("never prints credential values", () => {
    expect(script).not.toMatch(/echo[^\n]*BRAIN_DEPLOY_SUDO_PASSWORD/u);
  });
});
