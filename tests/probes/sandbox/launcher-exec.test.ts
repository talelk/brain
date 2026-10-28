import { execFile as execFileCb } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const execa = promisify(execFileCb);
import { LauncherClient } from "../../../apps/runner/src/launcher-client";
import { startLauncher } from "../../../apps/launcher/src/server";

// Real constrained-launcher execution (T21/T22): requires Docker. Skips only
// when the Docker daemon is unreachable — a skip is a scope note, never a pass.
const dockerReady = await (async () => {
  try { return (await execa("docker", ["version", "--format", "ok"], { timeout: 10_000 })).stdout.trim() === "ok"; }
  catch { return false; }
})();

describe.skipIf(!dockerReady)("launcher sandbox execution (T21/T22)", () => {
  it("executes a governed tool inside an ephemeral read-only sandbox and stops it", async () => {
    // The launcher refuses non-allowlisted images; local probes ensure the
    // tool image exists and is bash-capable (production pins digest-verified
    // sandbox images instead of deriving them here).
    let bashOk = false;
    try { await execa("docker", ["run", "--rm", "brain-sandbox-tool", "/bin/bash", "-c", "ok"], { timeout: 30_000 }); bashOk = true; }
    catch { bashOk = false; }
    if (!bashOk) {
      await execa("docker", ["pull", "debian:stable-slim"], { timeout: 180_000 });
      await execa("docker", ["tag", "debian:stable-slim", "brain-sandbox-tool"], { timeout: 30_000 });
    }
    const dir = mkdtempSync(join(tmpdir(), "brain-launcher-exec-"));
    const toolsDir = join(dir, "tools", "fixture.echo");
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(join(toolsDir, "run.sh"), "#!/bin/bash\nread -r INPUT\necho \"{\\\"echoed\\\":$INPUT}\"\n", { mode: 0o755 });
    process.env["BRAIN_LAUNCHER_SOCKET"] = join(dir, "launcher.sock");
    process.env["BRAIN_LAUNCHER_TOKEN"] = "probe-launcher-token";
    const launcher = LauncherClient.fromEnv();
    let server: Promise<void> | undefined;
    try {
      server = startLauncher();
      // The socket file appears when the server listens.
      for (let i = 0; i < 50; i++) {
        try { await launcher.health(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      expect((await launcher.health()).docker).toBe(true);

      // Token enforcement: an unauthenticated client is refused.
      process.env["BRAIN_LAUNCHER_TOKEN"] = "wrong-token";
      const stranger = LauncherClient.fromEnv();
      await expect(stranger.createSandbox({ profile: "privileged-tool", requestId: "bad-1" })).rejects.toThrow(/401|token/);
      process.env["BRAIN_LAUNCHER_TOKEN"] = "probe-launcher-token";

      const { sandboxId } = await launcher.createSandbox({ profile: "privileged-tool", requestId: `exec-probe-${Date.now()}`, toolsDir: join(dir, "tools"), network: "none" });
      const result = await launcher.exec(sandboxId, "/tools/fixture.echo/run.sh", '{"message":"hi"}', 30_000);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ echoed: { message: "hi" } });
      const stopped = await launcher.stop(sandboxId);
      expect(stopped.terminationConfirmed).toBe(true);
    } finally {
      delete process.env["BRAIN_LAUNCHER_SOCKET"];
      delete process.env["BRAIN_LAUNCHER_TOKEN"];
      void server;
      rmSync(dir, { recursive: true, force: true });
    }
    }, 120_000);
});
