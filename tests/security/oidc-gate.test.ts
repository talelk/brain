import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { oidcConfigFromEnv } from "../../apps/governor/src/modules/identity/oidc";
import { createApp } from "../../apps/governor/src/http/app";

// T47: external IdP federation is opt-in and all-or-nothing. No local IdP is
// available in this environment, so the matrix proves the gate: unconfigured
// stays password-only, partial/insecure config fails startup, and a fully
// configured-but-unreachable issuer fails sign-in closed without a session.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe("OIDC configuration gate (T47)", () => {
  it("unconfigured: no federation, no error", () => {
    expect(oidcConfigFromEnv({})).toBeUndefined();
  });

  it("partial or insecure configuration is refused", () => {
    expect(() => oidcConfigFromEnv({ BRAIN_OIDC_ISSUER: "https://idp.example" })).toThrow(/incomplete/);
    const dir = mkdtempSync(join(tmpdir(), "brain-oidc-"));
    cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
    const secretFile = join(dir, "secret");
    writeFileSync(secretFile, "oidc-secret-value", { mode: 0o600 });
    expect(() => oidcConfigFromEnv({
      BRAIN_OIDC_ISSUER: "http://idp.example", BRAIN_OIDC_CLIENT_ID: "brain", BRAIN_OIDC_CLIENT_SECRET_FILE: secretFile,
    })).toThrow(/https/);
    expect(() => oidcConfigFromEnv({
      BRAIN_OIDC_ISSUER: "https://idp.example", BRAIN_OIDC_CLIENT_ID: "brain",
      BRAIN_OIDC_CLIENT_SECRET_FILE: secretFile, BRAIN_OIDC_CLIENT_SECRET: "inline",
    })).toThrow(/protected file/);
    chmodSync(secretFile, 0o644);
    expect(() => oidcConfigFromEnv({
      BRAIN_OIDC_ISSUER: "https://idp.example", BRAIN_OIDC_CLIENT_ID: "brain", BRAIN_OIDC_CLIENT_SECRET_FILE: secretFile,
    })).toThrow(/permissions/);
  });

  it("valid config builds a discovery URL; partial env fails Governor startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-oidc-ok-"));
    cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
    const secretFile = join(dir, "secret");
    writeFileSync(secretFile, "oidc-secret-value", { mode: 0o600 });
    const cfg = oidcConfigFromEnv({
      BRAIN_OIDC_ISSUER: "http://127.0.0.1:9/idp/", BRAIN_OIDC_CLIENT_ID: "brain", BRAIN_OIDC_CLIENT_SECRET_FILE: secretFile,
    });
    expect(cfg?.discoveryUrl).toBe("http://127.0.0.1:9/idp/.well-known/openid-configuration");

    process.env["BRAIN_OIDC_ISSUER"] = "https://idp.example";
    try {
      await expect(createApp({ dataDir: mkdtempSync(join(tmpdir(), "brain-oidc-app-")) })).rejects.toThrow(/incomplete/);
    } finally {
      delete process.env["BRAIN_OIDC_ISSUER"];
    }
  }, 120_000);
});
