import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const IMAGE = "brain-governor:t48";
const NAME = `brain-deploy-test-${Date.now().toString(36)}`;

// T48 deployment proof: the shipped image boots as a non-root user, becomes
// ready, serves the web shell, and persists data on its volume across a
// container restart. Verification runs through docker exec because rootless
// published ports are not host-reachable in every environment; the HTTP
// surface exercised is the real one. Skips when docker or the prebuilt
// image is absent (build with: docker build -t brain-governor:t48 .).
async function dockerOk(): Promise<boolean> {
  try {
    const { stdout } = await run("docker", ["image", "inspect", IMAGE, "--format", "{{.Id}}"], { timeout: 15_000 });
    return stdout.trim().length > 0;
  } catch { return false; }
}

async function inContainer(path: string): Promise<{ status: number; body: string }> {
  const script = `fetch('http://127.0.0.1:3100${path}').then(async r=>{console.log(JSON.stringify({status:r.status,body:(await r.text()).slice(0,400)}))}).catch(e=>{console.log(JSON.stringify({status:0,body:String(e)}))})`;
  const { stdout } = await run("docker", ["exec", NAME, "node", "-e", script], { timeout: 20_000 });
  const line = stdout.trim().split("\n").pop() ?? "{}";
  return JSON.parse(line) as { status: number; body: string };
}

async function waitReady(): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const r = await inContainer("/health/ready");
      if (r.status === 200 && r.body.includes('"ready":true')) return true;
    } catch { /* booting */ }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return false;
}

afterAll(async () => {
  await run("docker", ["rm", "-f", NAME], { timeout: 30_000 }).catch(() => undefined);
  await run("docker", ["volume", "rm", "-f", `${NAME}-data`], { timeout: 30_000 }).catch(() => undefined);
});

describe("deployment image (T48)", () => {
  it("boots non-root, serves ready + shell, and survives restart with data intact", async () => {
    if (!(await dockerOk())) {
      console.warn(`image ${IMAGE} not built; deployment probe skipped`);
      return;
    }
    await run("docker", ["run", "-d", "--name", NAME, "-v", `${NAME}-data:/data`, IMAGE], { timeout: 60_000 });
    expect(await waitReady()).toBe(true);
    const { stdout: user } = await run("docker", ["exec", NAME, "id", "-u"], { timeout: 15_000 });
    expect(Number(user.trim())).not.toBe(0);
    const shell = await inContainer("/");
    expect(shell.status).toBe(200);
    expect(shell.body).toContain("<title>Keyrus Brain");
    const setup = await inContainer("/v1/setup/status");
    expect(JSON.parse(setup.body).setupRequired).toBe(true);
    const { stdout: health } = await run("docker", ["inspect", NAME, "--format", "{{.State.Health.Status}}"], { timeout: 15_000 });
    expect(["starting", "healthy"]).toContain(health.trim());

    await run("docker", ["restart", NAME], { timeout: 60_000 });
    expect(await waitReady()).toBe(true);
    const { stdout: files } = await run("docker", ["exec", NAME, "ls", "/data"], { timeout: 15_000 });
    expect(files).toContain("setup.token");
    expect(files).toContain("control.db");
  }, 300_000);
});
