import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Heals below the application (Phase 1, "heal below the application"): checks the launcher, the runners and the model proxy from the
 * host and restarts what is dead or hung, instead of waiting for a person. Run every minute by a systemd timer
 * (deploy/demo/brain-watchdog.timer). systemd's own Restart= covers a crash; this covers a process that is alive but stopped answering.
 *
 * A check must fail twice in a row before anything is restarted (one slow answer is not an outage), a thing is restarted at most three
 * times an hour (a restart loop is a problem to alert on, not to hide), and a launcher restart also restarts the runners that talk to it.
 */
export type CheckKind = "unix-http" | "http" | "unit";
export interface CheckSpec {
  readonly name: string;
  readonly kind: CheckKind;
  /** unix-http: socket path; http: URL; unit: systemd unit name. */
  readonly target: string;
  /** unix-http only: the path to GET. */
  readonly path?: string;
  /** What to restart when the check keeps failing: `unit:<name>` (systemctl) or `container:<name>` (docker). */
  readonly restart: string;
  /** Restarted together after this check's own restart. */
  readonly alsoRestart?: readonly string[];
}
export interface WatchdogState { readonly failures: Readonly<Record<string, number>>; readonly restarts: Readonly<Record<string, readonly number[]>> }
export type Probe = (spec: CheckSpec) => Promise<boolean>;
export type Restart = (what: string) => Promise<boolean>;

export const FAILS_BEFORE_RESTART = 2;
export const MAX_RESTARTS_PER_HOUR = 3;
const HOUR_MS = 3_600_000;

/** The default checks of the demo host layout (deploy-demo.sh): launcher socket, the two runner units and the memory proxy container. */
export function defaultChecks(env: NodeJS.ProcessEnv = process.env): CheckSpec[] {
  const runDir = env["BRAIN_WATCHDOG_RUN_DIR"] ?? "/srv/demos/brain/run";
  return [
    { name: "launcher", kind: "unix-http", target: env["BRAIN_LAUNCHER_SOCKET"] ?? `${runDir}/launcher.sock`, path: "/v1/health", restart: "unit:brain-launcher.service", alsoRestart: ["unit:brain-runner-agents.service", "unit:brain-runner-evaluators.service"] },
    { name: "runner-agents", kind: "unit", target: "brain-runner-agents.service", restart: "unit:brain-runner-agents.service" },
    { name: "runner-evaluators", kind: "unit", target: "brain-runner-evaluators.service", restart: "unit:brain-runner-evaluators.service" },
    { name: "model-proxy", kind: "http", target: env["BRAIN_WATCHDOG_PROXY_URL"] ?? "http://127.0.0.1:8096/health", restart: "container:tdai-memory-proxy" },
  ];
}

export interface Round { readonly state: WatchdogState; readonly restarted: readonly string[]; readonly gaveUp: readonly string[]; readonly healthy: readonly string[] }

/** One pass over the checks. Pure apart from the injected probe and restart; the state in and out is what persists between passes. */
export async function round(checks: readonly CheckSpec[], state: WatchdogState, probe: Probe, restart: Restart, now: number): Promise<Round> {
  const failures: Record<string, number> = { ...state.failures };
  const restarts: Record<string, number[]> = Object.fromEntries(Object.entries(state.restarts).map(([key, value]) => [key, value.filter((at) => now - at < HOUR_MS)]));
  const restarted: string[] = [];
  const gaveUp: string[] = [];
  const healthy: string[] = [];
  for (const spec of checks) {
    const ok = await probe(spec).catch(() => false);
    if (ok) { failures[spec.name] = 0; healthy.push(spec.name); continue; }
    failures[spec.name] = (failures[spec.name] ?? 0) + 1;
    if ((failures[spec.name] ?? 0) < FAILS_BEFORE_RESTART) continue;
    const history = restarts[spec.name] ?? [];
    if (history.length >= MAX_RESTARTS_PER_HOUR) { gaveUp.push(spec.name); continue; }
    const done = await restart(spec.restart).catch(() => false);
    restarts[spec.name] = [...history, now];
    if (!done) continue;
    restarted.push(spec.name);
    failures[spec.name] = 0;
    for (const other of spec.alsoRestart ?? []) if (await restart(other).catch(() => false)) restarted.push(other);
  }
  return { state: { failures, restarts }, restarted, gaveUp, healthy };
}

function probeUnixHttp(socketPath: string, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ socketPath, path, method: "GET", timeout: 5000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}
const run = (file: string, args: readonly string[]): Promise<{ ok: boolean; out: string }> =>
  new Promise((resolve) => execFile(file, [...args], { timeout: 60_000 }, (error, stdout) => resolve({ ok: !error, out: String(stdout) })));

/** The real probe: a socket answering 200, a URL answering 2xx, or a unit that is active. */
export const hostProbe: Probe = async (spec) => {
  if (spec.kind === "unix-http") return existsSync(spec.target) && (await probeUnixHttp(spec.target, spec.path ?? "/"));
  if (spec.kind === "http") { try { return (await fetch(spec.target, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; } }
  return (await run("systemctl", ["is-active", "--quiet", spec.target])).ok;
};
/** The real restart: `systemctl restart` through sudo -n (a sudoers rule for exactly these units), or `docker restart`. */
export const hostRestart: Restart = async (what) => {
  const [kind, name = ""] = what.split(":");
  if (!/^[A-Za-z0-9_.@-]+$/u.test(name)) return false;
  if (kind === "unit") return (await run("sudo", ["-n", "systemctl", "restart", name])).ok;
  if (kind === "container") return (await run("docker", ["restart", name])).ok;
  return false;
};

export function loadState(file: string): WatchdogState {
  try { return JSON.parse(readFileSync(file, "utf8")) as WatchdogState; } catch { return { failures: {}, restarts: {} }; }
}
export function saveState(file: string, state: WatchdogState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state));
}

/** Exit codes: 0 all healthy or healed, 1 something is still failing or the restart budget is spent (alert a person). */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const file = env["BRAIN_WATCHDOG_STATE"] ?? "/tmp/brain-watchdog-state.json";
  const checks = env["BRAIN_WATCHDOG_CHECKS"] ? (JSON.parse(env["BRAIN_WATCHDOG_CHECKS"]) as CheckSpec[]) : defaultChecks(env);
  const result = await round(checks, loadState(file), hostProbe, hostRestart, Date.now());
  saveState(file, result.state);
  for (const name of result.restarted) process.stdout.write(`watchdog: restarted ${name}\n`);
  for (const name of result.gaveUp) process.stderr.write(`watchdog: ${name} keeps failing and was already restarted ${MAX_RESTARTS_PER_HOUR} times this hour; a person must look\n`);
  const stillFailing = checks.filter((spec) => !result.healthy.includes(spec.name) && !result.restarted.includes(spec.name));
  return result.gaveUp.length > 0 || stillFailing.some((spec) => (result.state.failures[spec.name] ?? 0) >= FAILS_BEFORE_RESTART) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
