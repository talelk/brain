import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lookup } from "node:dns/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEgressGrant } from "../../../apps/launcher/src/egress-proxy";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const HOST = "unix:///run/user/1000/docker.sock";

async function docker(args: string[], timeout = 60_000): Promise<{ stdout: string; stderr: string }> {
  return run("docker", args, { timeout, env: { ...process.env, DOCKER_HOST: HOST }, maxBuffer: 1024 * 1024 });
}

// G06 egress proof on the rootless daemon: sandbox on an internal network
// can reach only the model endpoint its grant lists, and only via the proxy (ADR 0037).
describe("G06 allowlist egress proxy, sandbox network denial (E067)", () => {
  it("allows listed host via proxy, denies others and direct egress", async () => {
    let dockerOk = true;
    try {
      await docker(["info", "--format", "{{.ServerVersion}}"], 10_000);
    } catch { dockerOk = false; }
    if (!dockerOk) {
      console.warn("rootless docker unavailable; egress probe skipped");
      return;
    }
    const net = `brain-internal-test-${Date.now()}`;
    await docker(["network", "create", "--internal", net]);
    try {
      const modelIp = (await lookup("tntungx10")).address;
      const grantsDir = mkdtempSync(join(tmpdir(), "brain-egress-probe-"));
      const grant = writeEgressGrant(grantsDir, ["tntungx10:8000"]);
      const proxy = `http://${grant.id}:${grant.token}@brain-proxy-test:18080`;
      await docker(["run", "-d", "--name", "brain-proxy-test", "--network", net, "--add-host", `tntungx10:${modelIp}`,
        "-v", `${process.cwd()}/apps/launcher/src/egress-proxy.ts:/app/egress-proxy.ts:ro`, "-v", `${grantsDir}:/grants:ro`,
        "-e", "BRAIN_EGRESS_GRANTS_DIR=/grants",
        "node:24-slim", "node", "/app/egress-proxy.ts"]);
      // The internal network has no external route, so the proxy container
      // also needs egress. Connect it to the default bridge as its uplink.
      await docker(["network", "connect", "bridge", "brain-proxy-test"]);
      await new Promise((r) => setTimeout(r, 1500));

      const allowed = await docker(["run", "--rm", "--network", net,
        "-e", `http_proxy=${proxy}`, "-e", `HTTP_PROXY=${proxy}`,
        "python:3.12-alpine", "python3", "-c",
        "import urllib.request; print(urllib.request.urlopen('http://tntungx10:8000/v1/models', timeout=10).status)"]);
      expect(allowed.stdout).toContain("200");

      let deniedStatus = "";
      try {
        const denied = await docker(["run", "--rm", "--network", net,
          "-e", `http_proxy=${proxy}`, "-e", `HTTP_PROXY=${proxy}`,
          "python:3.12-alpine", "python3", "-c",
          "import urllib.request; urllib.request.urlopen('http://example.com/', timeout=10)"]);
        deniedStatus = denied.stdout;
      } catch (e) {
        deniedStatus = String((e as { stderr?: string }).stderr ?? e);
      }
      expect(deniedStatus).toMatch(/403|Forbidden|denied/i);

      let direct = "";
      try {
        const out = await docker(["run", "--rm", "--network", net,
          "python:3.12-alpine", "python3", "-c",
          "import urllib.request; print(urllib.request.urlopen('http://tntungx10:8000/v1/models', timeout=5).status)"], 30_000);
        direct = out.stdout;
      } catch (e) {
        direct = String((e as { stderr?: string }).stderr ?? e);
      }
      expect(direct).not.toContain("200");
    } finally {
      await docker(["rm", "-f", "brain-proxy-test"]).catch(() => undefined);
      await docker(["network", "rm", net]).catch(() => undefined);
    }
  }, 240_000);
});
