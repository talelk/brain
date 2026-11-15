import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeToolPayload } from "../../apps/runner/src/tools/invoke";
import type { RunnerConfig } from "../../apps/runner/src/supervisor";
import type { LauncherClient } from "../../apps/runner/src/launcher-client";

// Story 105 (ADR 0037) at the runner: a sandboxed tool gets a network only through the proxy and only for the hosts of the offer's
// workspace allowlist; with none it gets no network, and a tool that runs a privileged effect never has one.
let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });

function setup(): RunnerConfig {
  root = mkdtempSync(join(tmpdir(), "brain-egress-sandbox-"));
  mkdirSync(join(root, "tools", "fixture.echo"), { recursive: true });
  writeFileSync(join(root, "tools", "fixture.echo", "run.sh"), "#!/bin/bash\nprintf '{\"ok\":true}'\n", { mode: 0o755 });
  process.env["BRAIN_TOOLS_DIR"] = join(root, "tools");
  return { groupToolsDir: join(root, "tools") } as unknown as RunnerConfig;
}

function recordingLauncher(): { launcher: LauncherClient; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  const launcher = {
    createSandbox: async (input: Record<string, unknown>) => { created.push(input); return { sandboxId: "sb-egress" }; },
    exec: async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: "", timedOut: false }),
    stop: async () => ({ terminationConfirmed: true }),
  } as unknown as LauncherClient;
  return { launcher, created };
}

const offer = (effectClass: string) => ({ payload: { input: {}, step: { uses: { release: { id: "fixture.echo" } }, effectClass } }, execution: { kind: "tool" }, workspaceId: "ws-a" });
const permit = { token: "test-permit-token", permitId: "permit-test" };

describe("sandboxed tools reach only the workspace's egress hosts (story 105)", () => {
  it("a read tool of a workspace with hosts gets the internal network and exactly those hosts", async () => {
    const cfg = setup();
    const { launcher, created } = recordingLauncher();
    const result = await executeToolPayload({ offer: offer("read"), cfg, launcher, egressHosts: ["api.example.com", "models.internal:8000"] });
    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ profile: "agent", network: "internal", egressHosts: ["api.example.com", "models.internal:8000"] });
  });

  it("a workspace with no hosts gets no network at all", async () => {
    const cfg = setup();
    const { launcher, created } = recordingLauncher();
    await executeToolPayload({ offer: offer("read"), cfg, launcher, egressHosts: [] });
    await executeToolPayload({ offer: offer("read"), cfg, launcher });
    expect(created).toHaveLength(2);
    for (const request of created) { expect(request["network"]).toBe("none"); expect(request).not.toHaveProperty("egressHosts"); }
  });

  it("a privileged tool never gets a network, whatever the workspace allows", async () => {
    const cfg = setup();
    const { launcher, created } = recordingLauncher();
    await executeToolPayload({ offer: offer("privileged"), cfg, launcher, permit, egressHosts: ["api.example.com"] });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ profile: "privileged-tool", network: "none" });
    expect(created[0]).not.toHaveProperty("egressHosts");
  });
});
