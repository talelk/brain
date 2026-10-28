import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeToolPayload } from "../../apps/runner/src/tools/invoke";
import type { RunnerConfig } from "../../apps/runner/src/supervisor";

// T14: scoped secret delivery. Values live only in runner-local protected
// files; workflow input carries references. Privileged slots only, scoped
// per workspace, scrubbed from every returned stream, fail-closed otherwise.
const SECRET_VALUE = "t0p-secret-value-9f27";
let root = "";
let toolsDir = "";
let secretsDir = "";

function setup(leak: boolean): RunnerConfig {
  root = mkdtempSync(join(tmpdir(), "brain-secrets-"));
  toolsDir = join(root, "tools");
  secretsDir = join(root, "secrets");
  mkdirSync(join(toolsDir, "fixture.echo"), { recursive: true });
  mkdirSync(join(secretsDir, "ws-a"), { recursive: true });
  const script = leak
    ? `#!/bin/bash\nprintf '{"echoed":"%s"}' "$TARGET_TOKEN"\n`
    : `#!/bin/bash\nif [ -n "$TARGET_TOKEN" ]; then printf '{"present":true}'; else printf '{"present":false}'; fi\n`;
  writeFileSync(join(toolsDir, "fixture.echo", "run.sh"), script, { mode: 0o755 });
  writeFileSync(join(secretsDir, "ws-a", "target-token"), `${SECRET_VALUE}\n`, { mode: 0o600 });
  process.env["BRAIN_SECRETS_DIR"] = secretsDir;
  process.env["BRAIN_TOOLS_DIR"] = toolsDir;
  return { groupToolsDir: toolsDir } as unknown as RunnerConfig;
}

afterEach(() => {
  delete process.env["BRAIN_SECRETS_DIR"];
  delete process.env["BRAIN_TOOLS_DIR"];
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function offer(input: Record<string, unknown>, effectClass = "privileged", workspaceId = "ws-a") {
  return {
    payload: { input, step: { uses: { release: { id: "fixture.echo" } }, effectClass } },
    execution: { kind: "tool" }, workspaceId,
  };
}

describe("scoped secret delivery (T14)", () => {
  it("delivers a workspace-scoped secret to a privileged tool by reference only", async () => {
    const cfg = setup(false);
    const res = await executeToolPayload(offer({ secretRefs: { TARGET_TOKEN: "target-token" } }), cfg);
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ present: true });
    expect(JSON.stringify(res.output)).not.toContain(SECRET_VALUE);
  });

  it("scrubs a leaked secret value from tool output", async () => {
    const cfg = setup(true);
    const res = await executeToolPayload(offer({ secretRefs: { TARGET_TOKEN: "target-token" } }), cfg);
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res.output)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(res.output)).toContain("[redacted]");
  });

  it("fails closed: non-privileged slot, wrong workspace, missing secret, traversal, alternate spelling", async () => {
    const cfg = setup(false);
    const read = await executeToolPayload(offer({ secretRefs: { TARGET_TOKEN: "target-token" } }, "read"), cfg);
    expect(read.ok).toBe(false);
    const wrongWs = await executeToolPayload(offer({ secretRefs: { TARGET_TOKEN: "target-token" } }, "privileged", "ws-b"), cfg);
    expect(wrongWs.ok).toBe(false);
    const missing = await executeToolPayload(offer({ secretRefs: { TARGET_TOKEN: "nope" } }), cfg);
    expect(missing.ok).toBe(false);
    const traversal = await executeToolPayload(offer({ secretRefs: { TARGET_TOKEN: "../ws-a/target-token" } }), cfg);
    expect(traversal.ok).toBe(false);
    // Alternate spelling of the protected channel must not pass through.
    const alias = await executeToolPayload(offer({ secret_refs: { TARGET_TOKEN: "target-token" } }), cfg);
    expect(alias.ok).toBe(false);
    expect(JSON.stringify(alias.output)).toContain("unrecognized secret channel");
    // Open-permission secret files are refused.
    chmodSync(join(secretsDir, "ws-a", "target-token"), 0o644);
    const openPerms = await executeToolPayload(offer({ secretRefs: { TARGET_TOKEN: "target-token" } }), cfg);
    expect(openPerms.ok).toBe(false);
  });
});
