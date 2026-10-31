import { instancePaths, registerInstance, verifyInstance, resetInstance } from "./local-instance";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
async function main(): Promise<void> {
const instance = process.env["BRAIN_INSTANCE_DIR"] ?? join(homedir(), ".local", "share", "brain");
const env = { ...process.env, BRAIN_DATA_DIR: process.env["BRAIN_DATA_DIR"] ?? join(instance, "data"), BRAIN_RUN_DIR: process.env["BRAIN_RUN_DIR"] ?? join(instance, "run"), BRAIN_PORT: process.env["BRAIN_PORT"] ?? "3100" };
Object.assign(env, { BRAIN_CLI_STATE_DIR: process.env["BRAIN_CLI_STATE_DIR"] ?? join(instance, "cli"), BRAIN_GOVERNOR_URL: process.env["BRAIN_GOVERNOR_URL"] ?? `http://localhost:${env.BRAIN_PORT}`, BRAIN_BASE_URL: process.env["BRAIN_BASE_URL"] ?? `http://localhost:${env.BRAIN_PORT}` });
function run(command: string, args: string[], extra = {}) { const result = spawnSync(command, args, { env: { ...env, ...extra }, stdio: "inherit" }); if (result.error) throw result.error; if (result.status !== 0) process.exit(result.status ?? 1); }
const command = process.argv[2] ?? "start";
if (command === "start") {
  mkdirSync(instance, { recursive: true, mode: 0o700 });
  registerInstance(instancePaths(env));
  run("pnpm", ["build"]);
  run("bash", ["scripts/build-sandbox-images.sh"]);
  // Initialization needs exclusive ownership. A running instance is left alone.
  let running = false;
  try { running = (await fetch(`${env.BRAIN_GOVERNOR_URL}/health/live`, { signal: AbortSignal.timeout(1500) })).ok; } catch { /* first start */ }
  if (!running) run(process.execPath, ["--import", "tsx", "scripts/initialize-local.ts"], { BRAIN_LOCAL_RUNTIME_DIR: env.BRAIN_RUN_DIR });
  run("bash", ["scripts/up.sh"], { BRAIN_RUNNERS: "0", BRAIN_LOCAL_RUNTIME_DIR: env.BRAIN_RUN_DIR });
  console.log(`Open ${env.BRAIN_GOVERNOR_URL}. Sign in: ${env.BRAIN_ADMIN_EMAIL ?? "admin@brain.local"}${env.BRAIN_ADMIN_PASSWORD ? "" : " / admin-password"}. Pi and Claude runners use the configured local model; change it in Administration → Setup. Memory administration: ${process.env["BRAIN_MEMORY_UI_URL"] ?? "http://localhost:8125"}.`);
} else if (command === "backup") {
  const destination = process.argv[3]; if (!destination || destination.startsWith("--")) throw new Error("Usage: pnpm brain backup <new-backup-directory>");
  run("bash", ["scripts/down.sh"]);
  run("pnpm", ["--filter", "@brain/governor", "maintenance", "backup", env.BRAIN_DATA_DIR, destination]);
  run("pnpm", ["--filter", "@brain/governor", "maintenance", "verify", destination]);
  console.log("Local backup verified. Restarting the instance; consult backup completeness limits for external services.");
  run(process.execPath, ["--import", "tsx", "scripts/brain.ts", "start"]);
} else if (command === "restore") {
  const archive = process.argv[3]; if (!archive || archive.startsWith("--")) throw new Error("Usage: pnpm brain restore <backup-directory>");
  run("bash", ["scripts/down.sh"]);
  run("pnpm", ["--filter", "@brain/governor", "maintenance", "verify", archive]);
  run("pnpm", ["--filter", "@brain/governor", "maintenance", "restore", archive, env.BRAIN_DATA_DIR]);
  console.log("Restore verified. Execution remains suspended for controlled reconciliation. Run pnpm brain start to inspect the restored instance.");
} else if (command === "reset") {
  if (process.argv.slice(3).some((arg) => arg !== "--yes")) throw new Error("Usage: pnpm brain reset [--yes]");
  const paths = instancePaths(env);
  verifyInstance(paths);
  console.log(`Reset will remove all accounts, workspaces, releases, runs, artifacts, conversations, model settings, credentials and logs in:\n${paths.data}\n${paths.run}\n${paths.cli}`);
  console.log("Reset cannot undo actions already applied to external systems.");
  if (!process.argv.includes("--yes")) {
    if (!process.stdin.isTTY) throw new Error("Reset requires --yes in a noninteractive terminal");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question("Type RESET to erase this local instance: "); prompt.close();
    if (answer !== "RESET") throw new Error("Reset cancelled");
  }
  run("bash", ["scripts/down.sh"]);
  resetInstance(paths);
  console.log("Instance reset. Run pnpm brain start to generate a new administrator and populated workspace.");
} else if (command === "stop") run("bash", ["scripts/down.sh"]);
else if (command === "status") {
  try { const response = await fetch(`${env.BRAIN_GOVERNOR_URL}/health/ready`, { signal: AbortSignal.timeout(3000) }); const snapshot = await response.text(); console.log(process.argv.includes("--json") ? snapshot : `Brain server ${response.ok ? "is running" : "is not ready"} at ${env.BRAIN_GOVERNOR_URL}. Workspace readiness is shown in Administration → Setup.`); process.exitCode = response.ok ? 0 : 1; }
  catch { console.log("Brain is stopped or unreachable."); process.exitCode = 1; }
} else if (command === "logs") {
  const log = join(env.BRAIN_RUN_DIR, "governor.log");
  if (!existsSync(log)) throw new Error("No Governor log yet. Start Brain first.");
  run("tail", ["-n", "100", "-f", log]);
} else throw new Error("Usage: pnpm brain start|stop|status|logs|reset [--yes]|backup <directory>|restore <archive>");

}
try { await main(); } catch (error) { console.error(`Brain: ${error instanceof Error ? error.message : "Command failed"}`); process.exitCode = 1; }
