export interface RuntimeConfig {
  readonly requireTwoFactor: boolean;
  readonly memoryUiUrl: string | null;
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const flag = env["BRAIN_AUTH_REQUIRE_2FA"] ?? "false";
  if (flag !== "true" && flag !== "false") throw new Error("BRAIN_AUTH_REQUIRE_2FA must be true or false");
  function url(name: string): string | null {
    const value = env[name];
    if (!value) return null;
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error(`${name} must be an absolute HTTP(S) URL without credentials or a fragment`);
    return parsed.href;
  }
  if (env["BRAIN_TENCENTDB_URL"]) {
    const memory = new URL(env["BRAIN_TENCENTDB_URL"]);
    if (memory.username || memory.password || !["http:","https:"].includes(memory.protocol)) throw new Error("BRAIN_TENCENTDB_URL must be credential-free HTTP(S)");
    if (!["127.0.0.1","localhost","[::1]"].includes(memory.hostname) && (!env["BRAIN_TENCENTDB_API_KEY"] || env["BRAIN_TENCENTDB_API_KEY"] === "local-no-key")) throw new Error("non-loopback TencentDB requires BRAIN_TENCENTDB_API_KEY");
  }
  return Object.freeze({ requireTwoFactor: flag === "true", memoryUiUrl: url("BRAIN_MEMORY_UI_URL") });
}
