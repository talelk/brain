import { scaled } from "../support/timing";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeToolPayload } from "../../apps/runner/src/tools/invoke";
import { scrubSecrets, type SecretCredential, type SecretCredentialSource } from "../../apps/runner/src/tools/secrets";
import type { RunnerConfig } from "../../apps/runner/src/supervisor";
import type { LauncherClient } from "../../apps/runner/src/launcher-client";

// ADR 0070: the runner holds no secret store. A privileged tool that declares secrets gets short-lived credentials from the Governor for that
// call, hands them to the sandbox as that exec's environment, re-checks them at the last moment and scrubs them from everything it returns.
const SECRET_VALUE = "t0p-secret-value-9f27";
let root = "";
let toolsDir = "";

function setup(leak: boolean): RunnerConfig {
  root = mkdtempSync(join(tmpdir(), "brain-secrets-"));
  toolsDir = join(root, "tools");
  mkdirSync(join(toolsDir, "fixture.echo"), { recursive: true });
  const script = leak
    ? `#!/bin/bash\nprintf '{"echoed":"%s"}' "$TARGET_TOKEN"\n`
    : `#!/bin/bash\nif [ -n "$TARGET_TOKEN" ]; then printf '{"present":true}'; else printf '{"present":false}'; fi\n`;
  writeFileSync(join(toolsDir, "fixture.echo", "run.sh"), script, { mode: 0o755 });
  process.env["BRAIN_TOOLS_DIR"] = toolsDir;
  return { groupToolsDir: toolsDir } as unknown as RunnerConfig;
}

afterEach(() => {
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

/** The Governor as the runner sees it: what it mints, what it is asked to re-check, and whether it still honours a credential. */
function governor(options: { expiresInMs?: number; refuseValidation?: string; envName?: string } = {}): SecretCredentialSource & { minted: number; validated: string[][] } {
  const state = { minted: 0, validated: [] as string[][] };
  return Object.assign(state, {
    async mint(): Promise<SecretCredential[]> {
      state.minted++;
      return [{ id: "sc-1", envName: options.envName ?? "TARGET_TOKEN", value: SECRET_VALUE, expiresAt: new Date(Date.now() + (options.expiresInMs ?? 60_000)).toISOString() }];
    },
    async validate(ids: readonly string[]): Promise<void> {
      state.validated.push([...ids]);
      if (options.refuseValidation) throw new Error(options.refuseValidation);
    },
  });
}

/**
 * Test double for the constrained launcher: it executes the same script the container would, with exactly the secret env the runner hands
 * the launcher for that exec, so delivery, refusal and scrub run through the real executeToolPayload path.
 */
function stubLauncher(seen: Array<Readonly<Record<string, string>> | undefined> = []): LauncherClient {
  return {
    createSandbox: async () => ({ sandboxId: "sb-test" }),
    exec: async (_sandboxId: string, script: string, _input: string, _timeoutMs: number, secretEnv?: Readonly<Record<string, string>>) => {
      seen.push(secretEnv);
      const result = spawnSync("/bin/bash", [script.replace(/^\/tools/, toolsDir)], {
        input: "", encoding: "utf8", timeout: scaled(30_000),
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", ...(secretEnv ?? {}) },
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut: result.error !== undefined };
    },
    stop: async () => ({ terminationConfirmed: true }),
  } as unknown as LauncherClient;
}

const permit = { token: "test-permit-token", permitId: "permit-test" };
const refs = { secretRefs: { TARGET_TOKEN: "target-token" } };

describe("short-lived secret credentials on the runner (ADR 0070)", () => {
  it("refuses privileged execution without the constrained launcher, before any credential is asked for", async () => {
    const cfg = setup(false);
    const source = governor();
    const res = await executeToolPayload({ offer: offer(refs), cfg, secrets: source });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res.output)).toContain("constrained launcher");
    const withPermit = await executeToolPayload({ offer: offer(refs), cfg, permit, secrets: source });
    expect(JSON.stringify(withPermit.output)).toContain("constrained launcher");
    expect(source.minted).toBe(0);
  });

  it("hands the minted credential to the sandbox as that exec's environment, re-checked first, and never returns it", async () => {
    const cfg = setup(false);
    const source = governor();
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const res = await executeToolPayload({ offer: offer(refs), cfg, launcher: stubLauncher(seen), permit, secrets: source });
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ present: true });
    expect(seen).toEqual([{ TARGET_TOKEN: SECRET_VALUE }]);
    expect(source.validated).toEqual([["sc-1"]]);
    expect(JSON.stringify(res.output)).not.toContain(SECRET_VALUE);
  });

  it("scrubs a leaked credential from sandboxed tool output", async () => {
    const cfg = setup(true);
    const res = await executeToolPayload({ offer: offer(refs), cfg, launcher: stubLauncher(), permit, secrets: governor() });
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res.output)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(res.output)).toContain("[redacted]");
    expect(scrubSecrets(`token ${SECRET_VALUE} here`, [SECRET_VALUE])).toBe("token [redacted] here");
  });

  it("scrubs a credential a failing tool prints to stdout or stderr, and never puts one in a refusal", async () => {
    const cfg = setup(false);
    writeFileSync(join(toolsDir, "fixture.echo", "run.sh"), `#!/bin/bash\necho "{\\"error\\":\\"bad token $TARGET_TOKEN\\"}"\necho "stderr $TARGET_TOKEN" >&2\nexit 2\n`, { mode: 0o755 });
    const failed = await executeToolPayload({ offer: offer(refs), cfg, launcher: stubLauncher(), permit, secrets: governor() });
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed.output)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(failed.output)).toContain("[redacted]");
    const refused = await executeToolPayload({ offer: offer(refs), cfg, launcher: stubLauncher(), permit, secrets: governor({ refuseValidation: "it was revoked" }) });
    expect(JSON.stringify(refused.output)).not.toContain(SECRET_VALUE);
  });

  it("refuses a credential that expired before the tool ran, and asks the Governor so the refusal is audited", async () => {
    const cfg = setup(false);
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const expired = governor({ expiresInMs: -1 });
    const res = await executeToolPayload({ offer: offer(refs), cfg, launcher: stubLauncher(seen), permit, secrets: expired });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res.output)).toContain("expired");
    expect(seen).toEqual([]);
    // One that expires between minting and use is refused at the last check and the Governor hears of the attempted use.
    const short = governor({ expiresInMs: 40 });
    const slow = stubLauncher(seen);
    const slowed = { ...slow, createSandbox: async () => { await new Promise((r) => setTimeout(r, 80)); return { sandboxId: "sb-slow" }; } } as unknown as LauncherClient;
    const late = await executeToolPayload({ offer: offer(refs), cfg, launcher: slowed, permit, secrets: short });
    expect(late.ok).toBe(false);
    expect(JSON.stringify(late.output)).toContain("expired");
    expect(short.validated).toEqual([["sc-1"]]);
    expect(seen).toEqual([]);
  });

  it("refuses a credential the Governor no longer honours (revoked, fence moved) without running the tool", async () => {
    const cfg = setup(false);
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const res = await executeToolPayload({ offer: offer(refs), cfg, launcher: stubLauncher(seen), permit, secrets: governor({ refuseValidation: "the secret credential was refused: it was revoked" }) });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res.output)).toContain("no longer valid");
    expect(seen).toEqual([]);
  });

  it("fails closed: no Governor source, non-privileged slot, mismatched names, alternate spelling", async () => {
    const cfg = setup(false);
    const launcher = stubLauncher();
    const source = governor();
    const noSource = await executeToolPayload({ offer: offer(refs), cfg, launcher, permit });
    expect(noSource.ok).toBe(false);
    expect(JSON.stringify(noSource.output)).toContain("no secret credentials");
    const read = await executeToolPayload({ offer: offer(refs, "read"), cfg, secrets: source });
    expect(read.ok).toBe(false);
    expect(source.minted).toBe(0);
    // The Governor minted for a different declaration than the input names: the tool never runs with a foreign or partial set.
    const mismatch = await executeToolPayload({ offer: offer(refs), cfg, launcher, permit, secrets: governor({ envName: "OTHER_TOKEN" }) });
    expect(mismatch.ok).toBe(false);
    expect(JSON.stringify(mismatch.output)).toContain("do not match");
    const alias = await executeToolPayload({ offer: offer({ secret_refs: { TARGET_TOKEN: "target-token" } }), cfg, launcher, permit, secrets: source });
    expect(alias.ok).toBe(false);
    expect(JSON.stringify(alias.output)).toContain("unrecognized secret channel");
    const refused = await executeToolPayload({ offer: offer(refs), cfg, launcher, permit, secrets: { mint: async () => { throw new Error("this attempt's tool declares no secrets"); }, validate: async () => undefined } });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused.output)).toContain("declares no secrets");
  });
});
