import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, restore } from "../apps/governor/src/health/backup";
import { verify } from "../apps/governor/src/trust/audit";

/**
 * `pnpm brain <command>`: one Brain on this machine.
 *
 *   start            builds the web app when it is missing or older than its sources, starts the Governor, the git store, the launcher (when Docker
 *                    answers; the sandbox images are built when missing) and one runner, and prints the address. On a fresh install it
 *                    prints the setup link, which carries the setup token.
 *   stop             stops the runner, the launcher, the git store, the Governor and the egress proxy it started. Data is never touched.
 *   status           says what runs; exits 0 only when the Governor is ready.
 *   logs [name]      follows the log of `governor` (the default), `store`, `launcher` or `runner`.
 *   runner --governor <address> [--token-file <file>]
 *                    runs a runner on this machine for another Brain (a token comes from its Health screen), in this terminal, until
 *                    stopped. The token is read from the file, or from BRAIN_RUNNER_ENROLL_TOKEN; `--token <token>` works too but puts
 *                    the token on the command line, where `ps` shows it. The runner keeps its key in <home>/joined-<address>, so only
 *                    the first start needs the token.
 *   backup [file]    writes one archive of the data (brain.db through SQLite's backup API, cas/, workspaces/, the instance key, the
 *                    audit key, the store's keys and repositories) and leaves <data>/backup.marker. Works while Brain runs. Default: <home>/backups/brain-<time>.tar.gz
 *   restore <file>   puts a backup in place of the data. Refuses while Brain runs; what was there is moved aside, never deleted.
 *   audit-verify     verifies the audit log from its first event; exits 0 only when it holds.
 *
 * Environment:
 *   BRAIN_HOME        where this Brain lives (default ~/.local/share/brain): data/, run/ (pids, logs, the runner's folder), backups/
 *   BRAIN_DATA_DIR    the data directory (default <home>/data)
 *   BRAIN_RUN_DIR     pids, logs, the launcher's socket and the runner's folder (default <home>/run)
 *   BRAIN_PORT        the Governor's port (default 3100)
 *   BRAIN_BASE_URL    the address people open (default http://localhost:<port>)
 *   BRAIN_ENGINES     the runner's engines, comma-separated (default pi)
 *   BRAIN_PROFILE     `fixture` runs every agent on the fixture engine: no Docker, no model, so Brain can be tried anywhere
 * Anything else in the environment reaches the three processes as it is (BRAIN_RUNNER_SLOTS, BRAIN_LAUNCHER_HOST_COMMANDS, ...).
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOME = resolve(process.env["BRAIN_HOME"] ?? join(homedir(), ".local", "share", "brain"));
const DATA = resolve(process.env["BRAIN_DATA_DIR"] ?? join(HOME, "data"));
const STORE = join(HOME, "store");
const RUN = resolve(process.env["BRAIN_RUN_DIR"] ?? join(HOME, "run"));
const PORT = process.env["BRAIN_PORT"] ?? "3100";
const LOCAL = `http://127.0.0.1:${PORT}`;
const BASE_URL = process.env["BRAIN_BASE_URL"] ?? `http://localhost:${PORT}`;
const FIXTURE = process.env["BRAIN_PROFILE"] === "fixture";
const SOCKET = join(RUN, "launcher.sock");
const RUNNER_TOKEN = join(RUN, "runner.token");
const STORE_PORT = process.env["BRAIN_STORE_PORT"] ?? "3110";
const PARTS = { governor: "apps/governor/src/main.ts", store: "apps/store/src/main.ts", launcher: "apps/launcher/src/main.ts", runner: "apps/runner/src/main.ts" } as const;
type Part = keyof typeof PARTS;
const IMAGES = ["brain-sandbox-tool", "brain-sandbox-engine", "brain-egress-proxy"];

const say = (text: string): void => console.log(text);
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const quiet = (command: string, args: readonly string[]): { ok: boolean; out: string } => {
  const ran = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
  return { ok: ran.status === 0, out: (ran.stdout ?? "").trim() };
};
const has = (program: string): boolean => quiet("which", [program]).ok;

/** The pid of a part this command started, while that process is still the one it started. */
function pidOf(part: Part): number | undefined {
  const file = join(RUN, `${part}.pid`);
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8").trim());
  try {
    if (pid > 0 && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(PARTS[part])) return pid;
  } catch { /* the process is gone */ }
  rmSync(file, { force: true });
  return undefined;
}

/** Starts a part on its own, with its output in `<run>/<part>.log`. */
function startPart(part: Part, env: Record<string, string>): void {
  if (pidOf(part)) { say(`${part}: already running`); return; }
  const log = openSync(join(RUN, `${part}.log`), "a", 0o600);
  const child = spawn(process.execPath, ["--import", "tsx", PARTS[part]], { cwd: ROOT, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  child.on("error", (error) => { say(`${part}: could not be started: ${error.message}`); process.exitCode = 1; });
  child.unref();
  writeFileSync(join(RUN, `${part}.pid`), `${child.pid}\n`, { mode: 0o600 });
  say(`${part}: started (pid ${child.pid}, log ${join(RUN, `${part}.log`)})`);
}

async function stopPart(part: Part): Promise<void> {
  const pid = pidOf(part);
  if (!pid) { say(`${part}: not running`); return; }
  const signal = (name: NodeJS.Signals): void => { try { process.kill(-pid, name); } catch { /* already gone */ } };
  signal("SIGTERM");
  for (let waited = 0; waited < 10_000 && pidOf(part); waited += 200) await pause(200);
  if (pidOf(part)) signal("SIGKILL");
  rmSync(join(RUN, `${part}.pid`), { force: true });
  say(`${part}: stopped`);
}

const ready = async (): Promise<boolean> => {
  try { return (await fetch(`${LOCAL}/health/ready`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
};
const lastLines = (part: Part): string => (existsSync(join(RUN, `${part}.log`)) ? readFileSync(join(RUN, `${part}.log`), "utf8").trim().split("\n").slice(-15).join("\n") : "");

/** The newest change under a folder, in milliseconds. */
function newest(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) latest = Math.max(latest, entry.isDirectory() ? newest(join(dir, entry.name)) : statSync(join(dir, entry.name)).mtimeMs);
  return latest;
}

/** Builds the web app when it has never been built or its sources are newer. A build that fails does not stop the start: the API works without it. */
function buildWeb(): void {
  const web = join(ROOT, "apps", "web");
  const built = join(web, "dist", "index.html");
  if (!existsSync(join(web, "src"))) { say("web app: apps/web/src is not there, so nothing is built; the API starts without its pages"); return; }
  const sources = Math.max(newest(join(web, "src")), ...["index.html", "package.json", "vite.config.ts"].map((name) => (existsSync(join(web, name)) ? statSync(join(web, name)).mtimeMs : 0)));
  if (existsSync(built) && statSync(built).mtimeMs >= sources) return;
  say(existsSync(built) ? "web app: the sources are newer than the build, building" : "web app: not built yet, building");
  const ran = spawnSync("pnpm", ["--filter", "@brain/web", "build"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (ran.status === 0) { say("web app: built"); return; }
  say(`web app: the build failed, so ${existsSync(built) ? "the pages of the last build are served" : "there are no pages yet; the API still starts"}. Run "pnpm build" to see why. Last lines:`);
  say(`${ran.stdout ?? ""}${ran.stderr ?? ""}`.trim().split("\n").slice(-8).map((line) => `  ${line}`).join("\n"));
}

/**
 * What sandboxes need on this machine: the three images, the internal network and the egress proxy, which reads its grants from this
 * Brain's run folder. Engines in a sandbox reach the model gateway through the proxy, at the host's address on Docker's bridge; the
 * answer is that address (the Governor listens on it too) and the gateway address to offer. Undefined when sandboxes cannot be had.
 */
function prepareSandboxes(): { bridge: string; gatewayUrl: string } | undefined {
  if (!has("docker") || !quiet("docker", ["version", "--format", "{{.Server.Version}}"]).ok) {
    say("sandboxes: Docker does not answer, so no launcher is started. Agents that use their engine's own tools will wait for a runner that has sandboxes; BRAIN_PROFILE=fixture runs everything without Docker.");
    return undefined;
  }
  if (IMAGES.some((image) => !quiet("docker", ["image", "inspect", image, "--format", "{{.Id}}"]).ok)) {
    say("sandboxes: building the sandbox images (the first time takes a few minutes)");
    if (spawnSync("bash", ["scripts/build-sandbox-images.sh"], { cwd: ROOT, stdio: "inherit" }).status !== 0) {
      say("sandboxes: the images did not build, so no launcher is started");
      return undefined;
    }
  }
  const bridge = quiet("docker", ["network", "inspect", "bridge", "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}"]).out.split(/\s+/u).find((address) => /^\d+\.\d+\.\d+\.\d+$/u.test(address));
  if (!bridge) {
    say("sandboxes: Docker's bridge network has no address the Governor could listen on, so no launcher is started");
    return undefined;
  }
  const grants = join(RUN, "egress-grants");
  mkdirSync(grants, { recursive: true, mode: 0o700 });
  quiet("docker", ["network", "create", "--internal", "brain-internal"]);
  // One proxy per machine, under a fixed name the sandboxes know. One that reads another folder's grants, or allows another port, is replaced.
  const running = quiet("docker", ["container", "inspect", "brain-egress-proxy", "--format", '{{.State.Running}} {{range .Mounts}}{{.Source}}:{{.Destination}}{{end}} {{range .Config.Env}}{{println .}}{{end}}']).out;
  if (!(running.startsWith(`true ${grants}:/grants`) && running.includes(`BRAIN_EGRESS_ALLOW_INTERNAL=host.docker.internal:${PORT}`))) {
    quiet("docker", ["rm", "-f", "brain-egress-proxy"]);
    const started = quiet("docker", ["run", "-d", "--restart", "unless-stopped", "--name", "brain-egress-proxy", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--memory", "256m", "--pids-limit", "128", "--add-host", "host.docker.internal:host-gateway", "-e", `BRAIN_EGRESS_ALLOW_INTERNAL=host.docker.internal:${PORT}`,
      "-v", `${grants}:/grants:ro`, "brain-egress-proxy"]);
    if (!started.ok || !quiet("docker", ["network", "connect", "--alias", "brain-egress-proxy", "brain-internal", "brain-egress-proxy"]).ok) {
      say("sandboxes: the egress proxy container did not start, so no launcher is started");
      return undefined;
    }
  }
  return { bridge, gatewayUrl: `http://host.docker.internal:${PORT}` };
}

/** The commit of this checkout, marked when files differ from it; empty outside a git checkout. */
function commitOf(): string {
  const git = (...args: string[]) => spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8" });
  const head = git("rev-parse", "HEAD");
  if (head.status !== 0) return "";
  return `${head.stdout.trim()}${git("status", "--porcelain").stdout.trim() ? "-dirty" : ""}`;
}

async function start(): Promise<void> {
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  if (existsSync(DATA) && readdirSync(DATA).length > 0 && !existsSync(join(DATA, "brain.db"))) {
    throw new Error(`${DATA} holds files but no Brain database (brain.db), so it is not this Brain's data and is left as it is. Move it away (mv ${DATA} ${DATA}.old) or choose another place with BRAIN_HOME.`);
  }
  if (!pidOf("governor") && (await ready())) throw new Error(`something else already answers on port ${PORT}; stop it or choose another BRAIN_PORT`);
  buildWeb();
  const sandboxes = FIXTURE ? undefined : prepareSandboxes();

  if (!pidOf("governor")) rmSync(RUNNER_TOKEN, { force: true });
  startPart("governor", {
    BRAIN_COMMIT: commitOf(), BRAIN_DATA_DIR: DATA, PORT, BRAIN_BASE_URL: BASE_URL, BRAIN_LOCAL_RUNNER_TOKEN_FILE: RUNNER_TOKEN, BRAIN_STORE_URL: `http://127.0.0.1:${STORE_PORT}`,
    ...(sandboxes ? { BRAIN_BIND_HOST: `127.0.0.1,${sandboxes.bridge}`, BRAIN_GATEWAY_URL: sandboxes.gatewayUrl } : {}),
  });
  for (let waited = 0; waited < 60_000 && !(await ready()); waited += 500) {
    if (!pidOf("governor")) throw new Error(`the Governor stopped while starting. Its last lines:\n${lastLines("governor")}`);
    await pause(500);
  }
  if (!(await ready())) throw new Error(`the Governor is not ready after a minute. Its last lines:\n${lastLines("governor")}`);

  // Where attempts leave the state their successors start from; it checks tokens with the public key the Governor wrote.
  startPart("store", { BRAIN_STORE_DIR: STORE, BRAIN_STORE_PUBLIC_KEY_FILE: join(DATA, "store.pub"), PORT: STORE_PORT });

  if (sandboxes) {
    startPart("launcher", { BRAIN_LAUNCHER_SOCKET: SOCKET, BRAIN_LAUNCHER_ATTEMPTS_ROOT: join(RUN, "runner", "attempts"), BRAIN_LAUNCHER_EGRESS_GRANTS_DIR: join(RUN, "egress-grants") });
    for (let waited = 0; waited < 15_000 && !existsSync(SOCKET); waited += 250) await pause(250);
    if (!existsSync(SOCKET)) throw new Error(`the launcher did not open its socket. Its last lines:\n${lastLines("launcher")}`);
  }

  // The Governor leaves a token while it has no runner. A credential kept from an earlier data directory would not be known to it.
  const token = existsSync(RUNNER_TOKEN) ? readFileSync(RUNNER_TOKEN, "utf8").trim() : undefined;
  if (token && !pidOf("runner")) rmSync(join(RUN, "runner", "credential"), { force: true });
  mkdirSync(join(RUN, "runner", "attempts"), { recursive: true, mode: 0o700 });
  startPart("runner", {
    BRAIN_GOVERNOR_URL: LOCAL, BRAIN_RUNNER_STATE_DIR: join(RUN, "runner"), BRAIN_RUNNER_NAME: process.env["BRAIN_RUNNER_NAME"] ?? "local",
    BRAIN_RUNNER_SLOTS: process.env["BRAIN_RUNNER_SLOTS"] ?? "2", ...(token ? { BRAIN_RUNNER_ENROLL_TOKEN: token } : {}),
    // What tool scripts find: the tool sandbox image when there are sandboxes; the fixture profile says the same, and runs no script.
    BRAIN_RUNNER_CAPABILITIES: process.env["BRAIN_RUNNER_CAPABILITIES"] ?? (sandboxes || FIXTURE ? "bash,python3,curl,git" : ["bash", "python3", "curl", "git"].filter(has).join(",")),
    ...(FIXTURE ? { BRAIN_RUNNER_ENGINES: "fixture", BRAIN_RUNNER_FIXTURE_FOR: "pi,claude,opencode,codex" } : { BRAIN_RUNNER_ENGINES: process.env["BRAIN_ENGINES"] ?? "pi" }),
    ...(sandboxes ? { BRAIN_LAUNCHER_SOCKET: SOCKET } : {}),
  });
  for (let waited = 0; waited < 20_000 && pidOf("runner") && !existsSync(join(RUN, "runner", "credential")); waited += 250) await pause(250);
  await pause(500);
  if (!pidOf("runner")) say(`runner: it stopped. Its last lines:\n${lastLines("runner")}`);
  else rmSync(RUNNER_TOKEN, { force: true });

  say("");
  say(`Brain is running at ${BASE_URL}${FIXTURE ? " (fixture profile: agents answer from a script, with no model)" : ""}`);
  const setupToken = join(DATA, "setup.token");
  if (existsSync(setupToken)) say(`This is a fresh install. Create the first account here:\n  ${BASE_URL}/#token=${readFileSync(setupToken, "utf8").trim()}`);
  say('Stop it with "pnpm brain stop".');
}

/** Runs a runner for the Governor at `governor`, in the foreground. */
function joinRunner(governor: string, token: string | undefined): void {
  const address = new URL(governor);
  const state = join(HOME, `joined-${address.host.replace(/[^a-z0-9.-]/giu, "_")}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const ran = spawnSync(process.execPath, ["--import", "tsx", PARTS.runner], {
    cwd: ROOT, stdio: "inherit",
    env: {
      ...process.env, BRAIN_GOVERNOR_URL: address.origin, BRAIN_RUNNER_STATE_DIR: state, BRAIN_RUNNER_NAME: process.env["BRAIN_RUNNER_NAME"] ?? hostname(), ...(token ? { BRAIN_RUNNER_ENROLL_TOKEN: token } : {}),
      BRAIN_RUNNER_CAPABILITIES: process.env["BRAIN_RUNNER_CAPABILITIES"] ?? (FIXTURE ? "bash,python3,curl,git" : ["bash", "python3", "curl", "git"].filter(has).join(",")),
      ...(FIXTURE ? { BRAIN_RUNNER_ENGINES: "fixture", BRAIN_RUNNER_FIXTURE_FOR: "pi,claude,opencode,codex" } : { BRAIN_RUNNER_ENGINES: process.env["BRAIN_ENGINES"] ?? "pi" }),
    },
  });
  if (ran.error) throw ran.error;
  process.exitCode = ran.status ?? 1;
}

/** The value of `--name <value>` or `--name=<value>` among the arguments. */
function flag(name: string): string | undefined {
  const args = process.argv.slice(3);
  const at = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  return at < 0 ? undefined : args[at]?.startsWith(`${name}=`) ? args[at]?.slice(name.length + 1) : args[at + 1];
}

async function main(): Promise<void> {
  const [command = "", argument] = process.argv.slice(2);
  if (command === "start") return start();
  if (command === "runner") {
    const governor = flag("--governor");
    if (!governor) throw new Error("say which Brain to join: pnpm brain runner --governor <address> --token-file <file>");
    if (!URL.canParse(governor)) throw new Error(`${governor} is not an address; write it like http://brain.example:3100`);
    const file = flag("--token-file");
    return joinRunner(governor, flag("--token") ?? (file ? readFileSync(file, "utf8").trim() : undefined));
  }
  if (command === "stop") {
    for (const part of ["runner", "launcher", "store", "governor"] as const) await stopPart(part);
    // The egress proxy this Brain started (the one that reads this run folder's grants) goes with it.
    if (has("docker") && quiet("docker", ["container", "inspect", "brain-egress-proxy", "--format", "{{range .Mounts}}{{.Source}}{{end}}"]).out === join(RUN, "egress-grants")) quiet("docker", ["rm", "-f", "brain-egress-proxy"]);
    return;
  }
  if (command === "status") {
    for (const part of ["governor", "store", "launcher", "runner"] as const) say(`${part}: ${pidOf(part) ? `running (pid ${pidOf(part)})` : "not running"}`);
    const answers = await ready();
    say(answers ? `Brain is ready at ${BASE_URL} (data in ${DATA})` : `Brain does not answer on port ${PORT}`);
    process.exitCode = answers ? 0 : 1;
    return;
  }
  if (command === "logs") {
    const part = (argument ?? "governor") as Part;
    if (!(part in PARTS) || !existsSync(join(RUN, `${part}.log`))) throw new Error(`there is no log of "${part}" in ${RUN}; the logs are governor, store, launcher and runner`);
    spawnSync("tail", ["-n", "100", "-f", join(RUN, `${part}.log`)], { stdio: "inherit" });
    return;
  }
  if (command === "backup") {
    const made = await backup(DATA, argument ?? join(HOME, "backups", `brain-${new Date().toISOString().replace(/[:.]/gu, "-")}.tar.gz`), STORE);
    say(`Backup written to ${made.file}\nIt holds the key that encrypts this Brain's secrets: keep it as you would keep them.`);
    return;
  }
  if (command === "restore") {
    if (!argument) throw new Error("say which backup: pnpm brain restore <file>");
    if (pidOf("governor") || (await ready())) throw new Error('Brain is running on this data; stop it first ("pnpm brain stop"), then restore');
    const { kept, keptStore } = restore(argument, DATA, STORE);
    say(`Restored ${resolve(argument)} into ${DATA}.${[kept, keptStore].filter(Boolean).map((path) => `\nWhat was there before is kept in ${path}`).join("")}\nStart Brain with "pnpm brain start".`);
    return;
  }
  if (command === "audit-verify") {
    if (!existsSync(join(DATA, "brain.db"))) throw new Error(`${DATA} holds no Brain database (brain.db)`);
    const db = new Database(join(DATA, "brain.db"), { readonly: true, fileMustExist: true });
    try {
      const result = verify(db);
      say(result.ok ? `The audit log holds: ${result.events} events verified` : `The audit log does NOT hold: ${result.break?.detail ?? "it does not verify"}`);
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      db.close();
    }
    return;
  }
  throw new Error("usage: pnpm brain start | stop | status | logs [governor|store|launcher|runner] | runner --governor <address> [--token-file <file>] | backup [file] | restore <file> | audit-verify");
}

try {
  await main();
} catch (error) {
  console.error(`Brain: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
