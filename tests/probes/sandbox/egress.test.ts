import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
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
    // Nothing here reaches the internet or a tailnet: the allowed upstream is a throwaway container on its own network, which the proxy
    // is told to treat as an internal host on purpose (BRAIN_EGRESS_ALLOW_INTERNAL), as an operator would a model gateway.
    const stamp = Date.now();
    const net = `brain-internal-test-${stamp}`;
    const uplink = `brain-uplink-test-${stamp}`;
    await docker(["network", "create", "--internal", net]);
    await docker(["network", "create", uplink]);
    const grantsDir = mkdtempSync(join(tmpdir(), "brain-egress-probe-"));
    try {
      await docker(["run", "-d", "--name", "brain-upstream-test", "--network", uplink, "--network-alias", "fake-upstream", "python:3.12-alpine",
        "sh", "-c", "echo upstream-ok > /srv/index.html && cd /srv && python3 -m http.server 8000"]);
      const grant = writeEgressGrant(grantsDir, ["fake-upstream:8000"]);
      const proxy = `http://${grant.id}:${grant.token}@brain-proxy-test:18080`;
      await docker(["run", "-d", "--name", "brain-proxy-test", "--network", net,
        "-v", `${process.cwd()}/apps/launcher/src/egress-proxy.ts:/app/egress-proxy.ts:ro`, "-v", `${grantsDir}:/grants:ro`,
        "-e", "BRAIN_EGRESS_GRANTS_DIR=/grants", "-e", "BRAIN_EGRESS_ALLOW_INTERNAL=fake-upstream:8000",
        "node:24-slim", "node", "/app/egress-proxy.ts"]);
      // The internal network has no route out, so the proxy also joins the uplink network, where the upstream lives.
      await docker(["network", "connect", uplink, "brain-proxy-test"]);
      await new Promise((r) => setTimeout(r, 1500));

      const viaProxy = (url: string): string[] => ["run", "--rm", "--network", net, "-e", `http_proxy=${proxy}`, "-e", `HTTP_PROXY=${proxy}`,
        "python:3.12-alpine", "python3", "-c", `import urllib.request; print(urllib.request.urlopen('${url}', timeout=10).read().decode())`];
      const allowed = await docker(viaProxy("http://fake-upstream:8000/"));
      expect(allowed.stdout).toContain("upstream-ok");

      // A host the grant does not list is refused by the proxy, whatever it would resolve to.
      let deniedStatus = "";
      try { deniedStatus = (await docker(viaProxy("http://not-granted.example:8000/"))).stdout; } catch (e) { deniedStatus = String((e as { stderr?: string }).stderr ?? e); }
      expect(deniedStatus).toMatch(/403|Forbidden|denied/i);

      // The sandbox's own network has no way to the upstream except through the proxy.
      let direct = "";
      try {
        direct = (await docker(["run", "--rm", "--network", net, "python:3.12-alpine", "python3", "-c",
          "import urllib.request; print(urllib.request.urlopen('http://fake-upstream:8000/', timeout=5).read().decode())"], 30_000)).stdout;
      } catch (e) { direct = String((e as { stderr?: string }).stderr ?? e); }
      expect(direct).not.toContain("upstream-ok");
    } finally {
      await docker(["rm", "-f", "brain-proxy-test", "brain-upstream-test"]).catch(() => undefined);
      await docker(["network", "rm", net]).catch(() => undefined);
      await docker(["network", "rm", uplink]).catch(() => undefined);
      rmSync(grantsDir, { recursive: true, force: true });
    }
  }, 240_000);
});
