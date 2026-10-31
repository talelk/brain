import { lstatSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { LocalRunnerConfiguration } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";

function readPrivate(path: string): unknown {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077) || st.size > 16384 || (process.getuid && st.uid !== process.getuid())) throw new Error("Local runner configuration must be an owned private file");
  return JSON.parse(readFileSync(path, "utf8"));
}
export function localRevision(stateDirectory: string): string | null {
  const pointer = join(dirname(stateDirectory), "local-runtime-revision.json");
  if (!existsSync(pointer)) return null;
  const value = readPrivate(pointer) as { revision?: unknown };
  if (typeof value.revision !== "string" || !/^[a-f0-9-]{36}$/u.test(value.revision)) throw new Error("Invalid local configuration revision");
  return value.revision;
}
export function readLocalConfiguration(stateDirectory: string): LocalRunnerConfiguration | null {
  const revision = localRevision(stateDirectory);
  if (!revision) return null;
  const value = readPrivate(join(stateDirectory, `local-config.${revision}.json`));
  if (!validate("LocalRunnerConfiguration", value).ok) throw new Error("Invalid local runner configuration");
  return value as LocalRunnerConfiguration;
}
export function applyLocalConfiguration(configuration: LocalRunnerConfiguration, stateDirectory: string): void {
  process.env["BRAIN_RUNNER_ENGINE"] = configuration.engine;
  process.env["BRAIN_RUNNER_ENROLL_TOKEN"] = configuration.enrollmentToken;
  process.env["BRAIN_LOCAL_MODEL_URL"] = configuration.modelUrl;
  process.env["BRAIN_LOCAL_MODEL_ID"] = configuration.modelId;
  process.env["BRAIN_LOCAL_MODEL_API_KEY"] = configuration.apiKey ?? "";
  process.env["BRAIN_PI_AGENT_DIR"] = join(stateDirectory, "pi");
  const base = (process.env["BRAIN_RUNNER_CAPABILITIES"] ?? "os:linux,tool:bash,tool:python3,isolation:ephemeral-container").split(",").filter((cap) => !cap.startsWith("local-config:"));
  process.env["BRAIN_RUNNER_CAPABILITIES"] = [...base, `local-config:${configuration.revision}`].join(",");
}
