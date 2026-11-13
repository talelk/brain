import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("wires the database replica only when the server has replica.env, and ships it with a valid timer", () => {
    const compose = readFileSync(join(process.cwd(), "deploy/demo/docker-compose.yml"), "utf8");
    // Off by default: the Governor gets an empty BRAIN_REPLICA_DIR unless the deploy wrote it.
    expect(compose).toContain(`BRAIN_REPLICA_DIR: \${BRAIN_REPLICA_DIR:-}`);
    const wiring = script.slice(script.indexOf("# ---- continuous database replica"), script.indexOf("# ---- TencentDB memory stack"));
    expect(wiring).toContain('test -r $REMOTE_DIR/replica.env');
    expect(wiring.indexOf("test -r $REMOTE_DIR/replica.env")).toBeLessThan(wiring.indexOf("BRAIN_REPLICA_DIR=/replica"));
    expect(wiring).toContain("No $REMOTE_DIR/replica.env on the server: no database replica");
    // The timer is installed only when the guard said so, after the Governor was rolled.
    const timer = script.slice(script.indexOf("# ---- replica shipping timer"));
    expect(timer).toContain('if [ "$REPLICA_ON" = 1 ]');
    expect(script.indexOf("# ---- replica shipping timer")).toBeGreaterThan(script.indexOf("docker compose up -d governor"));
    for (const file of ["ship-replica.sh", "restore-from-replica.sh"]) execFileSync("bash", ["-n", `deploy/demo/replica/${file}`]);
    expect(readFileSync(join(process.cwd(), "deploy/demo/replica/brain-replica-ship.timer"), "utf8")).toContain("OnUnitActiveSec=1min");
  });

  it("prepares a second runner host: private env file, unit, no token on screen, https only", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-runner-host-"));
    try {
      const tokenFile = join(dir, "runner.token");
      writeFileSync(tokenFile, "enroll-token-do-not-print-0001\n", { mode: 0o600 });
      const run = (extra: string[], file = tokenFile) => spawnSync("bash", ["deploy/demo/runner-host/enroll-runner-host.sh", "--governor-url", "https://brain.example.test", "--token-file", file, "--id", "runner-agents-2", "--group", "agents", "--host-label", "beta", "--out", join(dir, "out"), ...extra], { encoding: "utf8" });
      const ok = run(["--slots", "4"]);
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout + ok.stderr).not.toContain("enroll-token-do-not-print");
      const env = readFileSync(join(dir, "out/runner-agents-2.env"), "utf8");
      expect(env).toContain("BRAIN_RUNNER_ID=runner-agents-2");
      expect(env).toContain("BRAIN_RUNNER_SLOTS=4");
      expect(env).toContain("host:beta");
      expect(env).toContain("BRAIN_RUNNER_ENROLL_TOKEN=enroll-token-do-not-print-0001");
      expect(statSync(join(dir, "out/runner-agents-2.env")).mode & 0o077).toBe(0);
      expect(readFileSync(join(dir, "out/brain-runner-runner-agents-2.service"), "utf8")).toContain("EnvironmentFile=");
      // Refusals: plain http to a remote Governor, a token file others can read, a bad group id.
      expect(spawnSync("bash", ["deploy/demo/runner-host/enroll-runner-host.sh", "--governor-url", "http://brain.example.test", "--token-file", tokenFile, "--id", "r-2", "--group", "agents", "--out", join(dir, "out2")], { encoding: "utf8" }).status).not.toBe(0);
      chmodSync(tokenFile, 0o644);
      expect(run([]).status).not.toBe(0);
      chmodSync(tokenFile, 0o600);
      expect(run(["--group", "Bad Group"]).status).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("never prints credential values", () => {
    expect(script).not.toMatch(/echo[^\n]*BRAIN_DEPLOY_SUDO_PASSWORD/u);
  });
});
