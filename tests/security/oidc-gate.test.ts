import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkIssuer, resolveSecretRef, secretDirectories } from "../../apps/governor/src/modules/identity/oidc";

// The single sign-on gate (ADR 0026, was T47): the provider is opt-in, the issuer must be https, and the client secret is only ever a
// reference to a protected file or to a process variable: a weak, missing or world-readable secret is refused when the setting is saved.
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const secretFile = (mode: number, text = "oidc-secret-value") => {
  const dir = mkdtempSync(join(tmpdir(), "brain-oidc-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "secret");
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
  return file;
};

describe("OIDC configuration gate", () => {
  it("accepts https issuers and only loopback http, without credentials, query or fragment", () => {
    expect(checkIssuer("https://login.example.com/tenant/")).toBe("https://login.example.com/tenant");
    expect(checkIssuer("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
    expect(checkIssuer("http://localhost:9000/")).toBe("http://localhost:9000");
    expect(() => checkIssuer("http://idp.example.com")).toThrow(/https/u);
    expect(() => checkIssuer("not a url")).toThrow(/absolute URL/u);
    expect(() => checkIssuer("https://user:pw@idp.example.com")).toThrow(/credentials/u);
    expect(() => checkIssuer("https://idp.example.com/?x=1")).toThrow(/query/u);
  });

  it("reads the secret from an owner-only file in a secrets folder or a BRAIN_OIDC_ variable and refuses everything else", () => {
    const inside = (mode: number, text?: string) => { const file = secretFile(mode, text); return { file, dirs: [file.slice(0, file.lastIndexOf("/"))] }; };
    const good = inside(0o600, "  oidc-secret-value\n");
    expect(resolveSecretRef(`file:${good.file}`, { dirs: good.dirs })).toBe("oidc-secret-value");
    expect(resolveSecretRef("env:BRAIN_OIDC_CLIENT_SECRET", { dirs: [], env: { BRAIN_OIDC_CLIENT_SECRET: "oidc-secret-value" } })).toBe("oidc-secret-value");
    const open = inside(0o644);
    expect(() => resolveSecretRef(`file:${open.file}`, { dirs: open.dirs })).toThrow(/no group or other permissions/u);
    const short = inside(0o600, "short");
    expect(() => resolveSecretRef(`file:${short.file}`, { dirs: short.dirs })).toThrow(/missing or too short/u);
    expect(() => resolveSecretRef("file:/no/such/file", { dirs: good.dirs })).toThrow(/does not exist/u);
    expect(() => resolveSecretRef("file:relative/path", { dirs: good.dirs })).toThrow(/does not exist/u);
    expect(() => resolveSecretRef("env:BRAIN_OIDC_UNSET", { dirs: [], env: {} })).toThrow(/missing or too short/u);
    expect(() => resolveSecretRef("literal-secret-in-the-setting", { dirs: [] })).toThrow(/must start with file:/u);
  });

  it("cannot be pointed at the Governor's own keys, files outside the secrets folder or other environment variables", () => {
    // The secret is sent to the issuer's token endpoint, so a setting must never name something the Governor keeps for itself.
    const keys = secretFile(0o600, "x".repeat(64));
    const elsewhere = secretFile(0o600, "oidc-secret-value");
    expect(() => resolveSecretRef(`file:${keys}`, { dirs: ["/run/secrets"] })).toThrow(/inside the Governor's secrets folder/u);
    expect(() => resolveSecretRef(`file:${elsewhere}`, { dirs: [mkdtempSync(join(tmpdir(), "brain-oidc-other-"))] })).toThrow(/secrets folder/u);
    expect(() => resolveSecretRef("env:BRAIN_AUTH_SECRET", { dirs: [], env: { BRAIN_AUTH_SECRET: "a-very-long-private-auth-secret" } })).toThrow(/BRAIN_OIDC_/u);
    expect(() => resolveSecretRef("env:PATH", { dirs: [] })).toThrow(/BRAIN_OIDC_/u);
    expect(secretDirectories("/srv/data", {})).toEqual(["/srv/data/secrets", "/run/secrets"]);
  });
});
