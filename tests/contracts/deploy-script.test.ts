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

  it("gives the runners concurrent sessions and re-applies them to the unit env on every deploy, not only the first", () => {
    expect(script).toContain('AGENT_SLOTS="${BRAIN_DEPLOY_AGENT_SLOTS:-3}"');
    expect(script).toContain('EVALUATOR_SLOTS="${BRAIN_DEPLOY_EVALUATOR_SLOTS:-2}"');
    expect(script).toContain("BRAIN_RUNNER_SLOTS=$AGENT_SLOTS");
    expect(script).toContain("BRAIN_RUNNER_SLOTS=$EVALUATOR_SLOTS");
    const rerun = script.slice(script.indexOf("\nelse\n  echo \"==> Updating runner capacity"));
    expect(rerun.indexOf("set_runner_env runner-agents.env")).toBeGreaterThan(-1);
    expect(rerun.indexOf("set_runner_env runner-agents.env")).toBeLessThan(rerun.indexOf("systemctl restart brain-launcher brain-runner-agents"));
    expect(script).toMatch(/set_runner_env\(\) \{[^\n]*grep -q[^\n]*sed -i[^\n]*>>/u);
  });

  it("never prints credential values", () => {
    expect(script).not.toMatch(/echo[^\n]*BRAIN_DEPLOY_SUDO_PASSWORD/u);
  });
});
