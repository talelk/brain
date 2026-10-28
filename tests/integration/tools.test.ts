import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeToolPayload } from "../../apps/runner/src/tools/invoke";
import type { RunnerConfig } from "../../apps/runner/src/supervisor";

// T22 packet acceptance: digest-pinned tool map (only declared tool ids can
// run), validated stdin/stdout bounds, fixed argv (bash + pinned script
// path, no shell interpolation), minimal scrubbed environment.
let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; delete process.env["BRAIN_TOOLS_DIR"]; });

function setup(scriptBody: string): RunnerConfig {
  root = mkdtempSync(join(tmpdir(), "brain-tools-"));
  mkdirSync(join(root, "fixture.echo"), { recursive: true });
  writeFileSync(join(root, "fixture.echo", "run.sh"), scriptBody, { mode: 0o755 });
  process.env["BRAIN_TOOLS_DIR"] = root;
  return { groupToolsDir: root } as unknown as RunnerConfig;
}
const offer = (input: Record<string, unknown>, toolId = "fixture.echo") => ({
  payload: { input, step: { uses: { release: { id: toolId } }, effectClass: "read" } },
  execution: { kind: "tool" }, workspaceId: "ws-tools",
});

describe("tool invocation bounds (T22)", () => {
  it("runs a pinned tool with JSON stdin and parses JSON stdout", async () => {
    const cfg = setup(`#!/bin/bash\ncat\n`);
    const res = await executeToolPayload({ offer: offer({ message: "hello" }), cfg: cfg });
    expect(res).toEqual({ ok: true, output: { message: "hello" } });
  });

  it("unknown tool ids and travelling script names cannot run", async () => {
    const cfg = setup(`#!/bin/bash\nprintf '{}'\n`);
    expect((await executeToolPayload({ offer: offer({}, "evil.tool"), cfg })).ok).toBe(false);
    expect((await executeToolPayload({ offer: offer({}, "../../etc/passwd"), cfg })).ok).toBe(false);
    expect((await executeToolPayload({ offer: offer({}, ""), cfg })).ok).toBe(false);
  });

  it("input and output size bounds are enforced; non-JSON output fails closed", async () => {
    const cfg = setup(`#!/bin/bash\nprintf 'not json'\n`);
    const big = await executeToolPayload({ offer: offer({ blob: "x".repeat(70 * 1024) }), cfg: cfg });
    expect(big.ok).toBe(false);
    expect(JSON.stringify(big.output)).toContain("too large");
    const badJson = await executeToolPayload({ offer: offer({ a: 1 }), cfg: cfg });
    expect(badJson.ok).toBe(false);
  });

  it("tool sees a scrubbed minimal environment (no runner secrets leak)", async () => {
    process.env["BRAIN_TEST_LEAK"] = "must-not-appear";
    try {
      const cfg = setup(`#!/bin/bash\nprintf '{"leak":"%s","home":"%s"}' "\${BRAIN_TEST_LEAK:-absent}" "$HOME"\n`);
      const res = await executeToolPayload({ offer: offer({}), cfg: cfg });
      expect(res.ok).toBe(true);
      expect(res.output).toEqual({ leak: "absent", home: "/tmp" });
    } finally {
      delete process.env["BRAIN_TEST_LEAK"];
    }
  });
});
