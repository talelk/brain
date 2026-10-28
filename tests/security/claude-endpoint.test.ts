import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLocalAnthropicHost, resolveAnthropicEndpoint } from "../../apps/runner/src/engines/claude";

// T25 endpoint/credential gate: no silent placeholder keys. Cloud-shaped
// endpoints require a real credential; placeholder is loopback/LAN-only and
// needs explicit opt-in; key files are permission-checked.
describe("anthropic endpoint gate (T25)", () => {
  it("classifies hosts", () => {
    expect(isLocalAnthropicHost("localhost")).toBe(true);
    expect(isLocalAnthropicHost("127.0.0.1")).toBe(true);
    expect(isLocalAnthropicHost("tntungx10")).toBe(true);
    expect(isLocalAnthropicHost("192.168.1.9")).toBe(true);
    expect(isLocalAnthropicHost("10.0.3.4")).toBe(true);
    expect(isLocalAnthropicHost("172.17.0.1")).toBe(true);
    expect(isLocalAnthropicHost("api.anthropic.com")).toBe(false);
    expect(isLocalAnthropicHost("8.8.8.8")).toBe(false);
    expect(isLocalAnthropicHost("proxy.example.com")).toBe(false);
  });

  it("refuses credential-less and placeholder configurations for cloud endpoints", () => {
    expect(() => resolveAnthropicEndpoint({})).toThrow(/credential required/);
    expect(() => resolveAnthropicEndpoint({ ANTHROPIC_API_KEY: "local-no-key" })).toThrow(/credential required/);
    expect(() => resolveAnthropicEndpoint({ BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY: "1" })).toThrow(/credential required/);
    expect(() => resolveAnthropicEndpoint({ BRAIN_ANTHROPIC_BASE_URL: "https://api.anthropic.com", BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY: "1" })).toThrow(/credential required/);
    expect(() => resolveAnthropicEndpoint({ BRAIN_ANTHROPIC_BASE_URL: "http://tntungx10:8000" })).toThrow(/ALLOW_LOCAL_NO_KEY=1/);
  });

  it("accepts real keys and explicit local opt-in", () => {
    expect(resolveAnthropicEndpoint({ ANTHROPIC_API_KEY: "sk-ant-real" })).toEqual({ baseUrl: undefined, keySource: "env", local: false });
    expect(resolveAnthropicEndpoint({ BRAIN_ANTHROPIC_BASE_URL: "http://tntungx10:8000", BRAIN_ANTHROPIC_ALLOW_LOCAL_NO_KEY: "1" }))
      .toEqual({ baseUrl: "http://tntungx10:8000", keySource: "local-placeholder", local: true });
    expect(() => resolveAnthropicEndpoint({ BRAIN_ANTHROPIC_BASE_URL: "not a url", ANTHROPIC_API_KEY: "k" })).toThrow(/not a valid URL/);
  });

  it("loads permission-checked key files and refuses world-readable ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-anthropic-"));
    const file = join(dir, "key");
    writeFileSync(file, "sk-ant-from-file\n", { mode: 0o600 });
    chmodSync(file, 0o600);
    const env: NodeJS.ProcessEnv = { BRAIN_ANTHROPIC_API_KEY_FILE: file };
    expect(resolveAnthropicEndpoint(env).keySource).toBe("file");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-from-file");
    chmodSync(file, 0o644);
    expect(() => resolveAnthropicEndpoint({ BRAIN_ANTHROPIC_API_KEY_FILE: file })).toThrow(/group\/world/);
  });
});
