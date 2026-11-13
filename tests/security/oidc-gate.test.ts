import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkIssuer, resolveSecretRef } from "../../apps/governor/src/modules/identity/oidc";

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

  it("reads the secret from an owner-only file or a process variable and refuses everything else", () => {
    expect(resolveSecretRef(`file:${secretFile(0o600, "  oidc-secret-value\n")}`)).toBe("oidc-secret-value");
    expect(resolveSecretRef("env:BRAIN_TEST_OIDC", { BRAIN_TEST_OIDC: "oidc-secret-value" })).toBe("oidc-secret-value");
    expect(() => resolveSecretRef(`file:${secretFile(0o644)}`)).toThrow(/no group or other permissions/u);
    expect(() => resolveSecretRef(`file:${secretFile(0o600, "short")}`)).toThrow(/missing or too short/u);
    expect(() => resolveSecretRef("file:/no/such/file")).toThrow(/does not exist/u);
    expect(() => resolveSecretRef("file:relative/path")).toThrow(/does not exist/u);
    expect(() => resolveSecretRef("env:BRAIN_TEST_OIDC_UNSET", {})).toThrow(/missing or too short/u);
    expect(() => resolveSecretRef("literal-secret-in-the-setting")).toThrow(/must start with file:/u);
  });
});
