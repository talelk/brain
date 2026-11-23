import { readFileSync } from "node:fs";
import type { BrainConfig } from "./client";
import type { MetricsConfig } from "./metrics";

/** `NAME=value` lines of a dotenv file (quotes around a value are dropped; `#` lines and `export ` are ignored). */
export const parseEnvFile = (text: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim().replace(/^export /u, "");
    const at = line.indexOf("=");
    if (line.startsWith("#") || at < 1) continue;
    values[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/u, "$2");
  }
  return values;
};

/** The address and sign-in, from BRAIN_URL, BRAIN_EMAIL and BRAIN_PASSWORD, or from the file BRAIN_MCP_ENV_FILE names (which may use BRAIN_LIVE_ADMIN_EMAIL and BRAIN_LIVE_ADMIN_PASSWORD). */
export const readConfig = (env: NodeJS.ProcessEnv): BrainConfig => {
  const file = env.BRAIN_MCP_ENV_FILE === undefined ? {} : parseEnvFile(readFileSync(env.BRAIN_MCP_ENV_FILE, "utf8"));
  const pick = (...names: string[]): string | undefined => names.map((name) => env[name] ?? file[name]).find((value) => value !== undefined && value !== "");
  const url = pick("BRAIN_URL");
  const email = pick("BRAIN_EMAIL", "BRAIN_LIVE_ADMIN_EMAIL");
  const password = pick("BRAIN_PASSWORD", "BRAIN_LIVE_ADMIN_PASSWORD");
  if (url === undefined || email === undefined || password === undefined) throw new Error("set BRAIN_URL and either BRAIN_EMAIL and BRAIN_PASSWORD or BRAIN_MCP_ENV_FILE (a dotenv file with BRAIN_LIVE_ADMIN_EMAIL and BRAIN_LIVE_ADMIN_PASSWORD)");
  return { url, email, password };
};

/** Where the metrics are, from VM_URL, VM_USER and VM_PASS, or from the file BRAIN_MCP_METRICS_ENV_FILE names; none when it is not set up. */
export const readMetricsConfig = (env: NodeJS.ProcessEnv): MetricsConfig | undefined => {
  const file = env.BRAIN_MCP_METRICS_ENV_FILE === undefined ? {} : parseEnvFile(readFileSync(env.BRAIN_MCP_METRICS_ENV_FILE, "utf8"));
  const pick = (name: string): string | undefined => [env[name], file[name]].find((value) => value !== undefined && value !== "");
  const url = pick("VM_URL");
  const user = pick("VM_USER");
  const password = pick("VM_PASS");
  return url === undefined || user === undefined || password === undefined ? undefined : { url, user, password };
};
