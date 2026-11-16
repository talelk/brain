import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { execa } from "execa";
import { isEgressHost, removeEgressGrant, writeEgressGrant } from "./egress-proxy";

/**
 * Engine sandboxes (ADR 0073): one container per attempt (and route) that runs an engine's host process, with its stdin and stdout held
 * by the launcher and handed to the runner as lines. The container's shape is decided here and only here: the request names the engine, the
 * attempt, the reservation and the hosts, and nothing else of it.
 */
export const ENGINE_IMAGE = "brain-sandbox-engine";
export const ENGINES: ReadonlySet<string> = new Set(["pi", "claude", "acp", "opencode", "codex"]);
/** Engines start threads and, for an ACP agent, child processes: more than a tool's 128, still a hard bound. */
export const ENGINE_PIDS_LIMIT = 512;
export const ENGINE_FIELDS = ["engine", "attemptId", "requestId", "cpuMillicores", "memoryMb", "egressHosts"] as const;
/** Where the attempt's state directory is inside the container; the only host path it ever sees. */
export const ENGINE_STATE_MOUNT = "/state";
const READY = /^@brain-engine \{"type":"ready"\}$/u;

export interface EngineSandboxShape {
  readonly name: string;
  readonly engine: string;
  readonly requestId: string;
  readonly cpuMillicores: number;
  readonly memoryMb: number;
  /** The host directory of this attempt's state, already checked to be under the operator's root. */
  readonly stateDirectory: string;
  /** `uid:gid` the engine runs as: the owner of the state directory. */
  readonly user: string;
  /** A file of `NAME=value` lines holding the proxy credentials: the argv names the file, never the secret. */
  readonly proxyEnvFile?: string | undefined;
  readonly grantId?: string | undefined;
}

/** The `docker run` argv of an engine sandbox: nothing in it comes from the caller except the values named in the shape. */
export function engineSandboxArgs(shape: EngineSandboxShape): string[] {
  const proxy = shape.proxyEnvFile ? ["--env-file", shape.proxyEnvFile, "-e", "no_proxy=127.0.0.1,localhost", "-e", "NODE_USE_ENV_PROXY=1"] : [];
  return ["run", "-i", "--rm", "--name", shape.name,
    "--network", shape.proxyEnvFile ? "brain-internal" : "none",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--cpus", String(Math.max(0.1, shape.cpuMillicores / 1000)), "--memory", `${shape.memoryMb}m`, "--memory-swap", `${shape.memoryMb}m`, "--pids-limit", String(ENGINE_PIDS_LIMIT),
    "--user", shape.user,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
    "-v", `${shape.stateDirectory}:${ENGINE_STATE_MOUNT}:rw`, "-w", ENGINE_STATE_MOUNT,
    "-e", "BRAIN_ENGINE_HOST=1", "-e", `HOME=${ENGINE_STATE_MOUNT}/home`, "-e", `BRAIN_PI_AGENT_DIR=${ENGINE_STATE_MOUNT}/.pi-agent`, "-e", `BRAIN_ACP_CWD=${ENGINE_STATE_MOUNT}`, "-e", `BRAIN_ENGINE=${shape.engine}`,
    ...proxy,
    "--label", `brain.engine-sandbox=${shape.requestId}`, ...(shape.grantId ? ["--label", `brain.egress-grant=${shape.grantId}`] : []),
    ENGINE_IMAGE];
}

/** The proxy credentials as an env file's text; they never appear in an argv, where `ps` and `docker inspect` would show them. */
export function proxyEnvText(proxyUrl: string): string {
  return ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"].map((name) => `${name}=${proxyUrl}\n`).join("");
}

interface EngineSandbox {
  readonly id: string;
  readonly requestId: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly grantId?: string | undefined;
  lines: string[];
  /** The index of `lines[0]` in the whole output: lines the runner has acknowledged are dropped. */
  base: number;
  exited: boolean;
  stderr: string;
  lastSeenMs: number;
  notify: Set<() => void>;
}

export interface EngineSandboxOptions {
  /** `BRAIN_LAUNCHER_ENGINE_STATE_ROOT`: the host directory under which every attempt's state directory lives. */
  readonly stateRoot: string | undefined;
  readonly egressGrantsDir: string | undefined;
  /** `uid:gid`; defaults to the launcher's own. */
  readonly user: string;
  /** A sandbox its runner has not spoken to for this long is stopped: a crashed runner leaves no container holding a network grant. */
  readonly idleMs: number;
  /** The reason the image may not run (a pin that does not match), or undefined. */
  readonly verifyImage: (image: string) => Promise<string | undefined>;
}

type Reply = { status: number; body: Record<string, unknown> };
const refuse = (status: number, error: string): Reply => ({ status, body: { error } });
const slug = (text: string): string => text.replace(/[^A-Za-z0-9_.-]/gu, "-").replace(/^[^A-Za-z0-9]+/u, "").slice(0, 80);

export class EngineSandboxes {
  private readonly live = new Map<string, EngineSandbox>();
  /** Creates in progress by request id: a second request for the same id waits for the first instead of starting a second container. */
  private readonly starting = new Map<string, Promise<Reply>>();
  private readonly finished = new Set<string>();
  private reaper: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: EngineSandboxOptions) {}

  /** Starts the idle check; the launcher process keeps no timer alive on its own. */
  startReaper(): void {
    this.reaper ??= setInterval(() => { void this.reap(); }, Math.max(50, Math.min(5000, Math.floor(this.options.idleMs / 3)))).unref();
  }

  async reap(now = Date.now()): Promise<void> {
    for (const sandbox of [...this.live.values()]) if (now - sandbox.lastSeenMs > this.options.idleMs) await this.stop(sandbox.id, 1000);
  }

  /** After a launcher restart no engine container can be reattached (its stdin was the launcher's): they are removed, grants with them. */
  async removeLeftovers(): Promise<void> {
    try {
      const listed = await execa("docker", ["ps", "-aq", "--filter", "label=brain.engine-sandbox"], { timeout: 15_000, reject: false });
      const ids = listed.exitCode === 0 ? String(listed.stdout).split("\n").map((id) => id.trim()).filter(Boolean) : [];
      if (ids.length > 0) await execa("docker", ["rm", "-f", ...ids], { timeout: 60_000, reject: false });
    } catch { /* docker unreachable: nothing to remove, and none can start */ }
  }

  create(body: Record<string, unknown>): Promise<Reply> {
    const requestId = String(body["requestId"] ?? "");
    const inFlight = this.starting.get(requestId);
    if (inFlight) return inFlight;
    const started = this.start(body).finally(() => this.starting.delete(requestId));
    this.starting.set(requestId, started);
    return started;
  }

  private async start(body: Record<string, unknown>): Promise<Reply> {
    for (const key of Object.keys(body)) if (!(ENGINE_FIELDS as readonly string[]).includes(key)) return refuse(422, `field ${key} forbidden`);
    const engine = String(body["engine"] ?? "");
    if (!ENGINES.has(engine)) return refuse(422, "unknown engine");
    const attemptId = String(body["attemptId"] ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(attemptId) || attemptId.includes("..")) return refuse(422, "attemptId invalid");
    const requestId = String(body["requestId"] ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(requestId)) return refuse(422, "requestId invalid");
    const cpu = body["cpuMillicores"];
    const memory = body["memoryMb"];
    if (typeof cpu !== "number" || !Number.isInteger(cpu) || cpu < 100 || cpu > 64_000) return refuse(422, "cpuMillicores must be an integer from 100 to 64000");
    if (typeof memory !== "number" || !Number.isInteger(memory) || memory < 128 || memory > 262_144) return refuse(422, "memoryMb must be an integer from 128 to 262144");
    const hosts = Array.isArray(body["egressHosts"]) ? body["egressHosts"].map((host) => String(host)) : [];
    if (hosts.length > 100 || hosts.some((host) => !isEgressHost(host))) return refuse(422, "egressHosts must be at most 100 lower-case host or host:port entries");
    const { stateRoot, egressGrantsDir } = this.options;
    if (!stateRoot) return refuse(409, "engine sandboxes are not configured on this launcher (BRAIN_LAUNCHER_ENGINE_STATE_ROOT)");
    if (hosts.length > 0 && !egressGrantsDir) return refuse(409, "the egress proxy is not configured on this launcher (BRAIN_LAUNCHER_EGRESS_GRANTS_DIR)");
    // The only host path in the container is this attempt's directory under the operator's root; a symlink or a path outside it never mounts.
    const directory = resolve(stateRoot, attemptId);
    if (!directory.startsWith(resolve(stateRoot) + sep)) return refuse(422, "attemptId invalid");
    try { if (!lstatSync(directory).isDirectory()) throw new Error("not a directory"); } catch { return refuse(409, "the attempt's state directory is absent on this host"); }
    const unverified = await this.options.verifyImage(ENGINE_IMAGE);
    if (unverified) return refuse(409, unverified);
    const prior = [...this.live.values()].find((sandbox) => sandbox.requestId === requestId && !sandbox.exited);
    if (prior) return { status: 200, body: { sandboxId: prior.id } };

    const name = `brain-engine-${slug(requestId)}-${Date.now().toString(36)}`;
    if (hosts.length > 0) await execa("docker", ["network", "create", "--internal", "brain-internal"], { timeout: 15_000, reject: false });
    const grant = hosts.length > 0 ? writeEgressGrant(egressGrantsDir!, hosts) : undefined;
    // The credentials reach the container through a 0600 file that exists only until the container has started.
    const envDir = grant ? mkdtempSync(join(tmpdir(), "brain-engine-env-")) : undefined;
    const envFile = envDir ? join(envDir, "proxy.env") : undefined;
    if (grant && envFile) writeFileSync(envFile, proxyEnvText(`http://${grant.id}:${grant.token}@brain-egress-proxy:18080`), { mode: 0o600 });
    const args = engineSandboxArgs({
      name, engine, requestId, cpuMillicores: cpu, memoryMb: memory, stateDirectory: directory, user: this.options.user,
      ...(grant ? { proxyEnvFile: envFile, grantId: grant.id } : {}),
    });
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const sandbox: EngineSandbox = { id: name, requestId, child, grantId: grant?.id, lines: [], base: 0, exited: false, stderr: "", lastSeenMs: Date.now(), notify: new Set() };
    const wake = (): void => { for (const resume of sandbox.notify) resume(); sandbox.notify.clear(); };
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
        if (READY.test(line)) resolveReady();
        sandbox.lines.push(line);
        wake();
      });
      child.stderr.on("data", (chunk: Buffer) => { sandbox.stderr = (sandbox.stderr + chunk.toString("utf8")).slice(-2000); });
      child.on("error", (error) => { sandbox.exited = true; sandbox.stderr += error.message; wake(); rejectReady(error); });
      child.on("close", () => { sandbox.exited = true; wake(); rejectReady(new Error("the engine host exited before it was ready")); });
      child.stdin.on("error", () => undefined);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    try {
      await ready;
    } catch (error) {
      child.kill("SIGKILL");
      await execa("docker", ["rm", "-f", name], { timeout: 30_000, reject: false });
      if (grant) removeEgressGrant(egressGrantsDir!, grant.id);
      return refuse(503, `docker run failed: ${(sandbox.stderr || (error instanceof Error ? error.message : "")).trim().slice(-500)}`);
    } finally { clearTimeout(timer); if (envDir) rmSync(envDir, { recursive: true, force: true }); }
    this.live.set(name, sandbox);
    return { status: 201, body: { sandboxId: name } };
  }

  input(id: string, b: Record<string, unknown>): Reply {
    const sandbox = this.live.get(id);
    if (!sandbox) return refuse(404, "engine sandbox not found");
    if (sandbox.exited) return refuse(409, "the engine sandbox has ended");
    const lines = Array.isArray(b["lines"]) ? b["lines"] : undefined;
    if (!lines || lines.some((line) => typeof line !== "string")) return refuse(422, "lines must be an array of strings");
    sandbox.lastSeenMs = Date.now();
    for (const line of lines as string[]) sandbox.child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
    return { status: 200, body: {} };
  }

  /** Lines from `after` on, waiting up to `waitMs` for one; what the runner has read is dropped, so the buffer holds only what is unread. */
  async output(id: string, after: number, waitMs: number): Promise<Reply> {
    const sandbox = this.live.get(id);
    if (!sandbox) return this.finished.has(id) ? { status: 200, body: { lines: [], next: after, closed: true } } : refuse(404, "engine sandbox not found");
    sandbox.lastSeenMs = Date.now();
    if (after > sandbox.base) { sandbox.lines.splice(0, after - sandbox.base); sandbox.base = after; }
    if (sandbox.lines.length === 0 && !sandbox.exited && waitMs > 0) {
      await new Promise<void>((resume) => { const done = (): void => { clearTimeout(timer); sandbox.notify.delete(done); resume(); }; const timer = setTimeout(done, Math.min(waitMs, 30_000)); sandbox.notify.add(done); });
      sandbox.lastSeenMs = Date.now();
    }
    const taken: string[] = [];
    let bytes = 0;
    for (const line of sandbox.lines) { if (taken.length > 0 && bytes + line.length > 1024 * 1024) break; taken.push(line); bytes += line.length; }
    return { status: 200, body: { lines: taken, next: sandbox.base + taken.length, closed: sandbox.exited && taken.length === sandbox.lines.length } };
  }

  async stop(id: string, graceMs: number): Promise<Reply> {
    const sandbox = this.live.get(id);
    if (!sandbox) return this.finished.has(id) ? { status: 200, body: { sandboxId: id, state: "stopped", terminationConfirmed: true, cleanupConfirmed: true } } : refuse(404, "engine sandbox not found");
    sandbox.child.stdin.end();
    await execa("docker", ["stop", "-t", String(Math.min(10, Math.max(0, graceMs / 1000))), sandbox.id], { timeout: 30_000, reject: false });
    await execa("docker", ["rm", "-f", sandbox.id], { timeout: 30_000, reject: false });
    const check = await execa("docker", ["inspect", sandbox.id], { timeout: 10_000, reject: false });
    const gone = check.exitCode !== 0;
    if (gone) {
      sandbox.child.kill("SIGKILL");
      this.live.delete(id);
      this.finished.add(id);
      if (this.finished.size > 256) this.finished.delete(this.finished.values().next().value as string);
      if (sandbox.grantId && this.options.egressGrantsDir) removeEgressGrant(this.options.egressGrantsDir, sandbox.grantId);
    }
    return { status: 200, body: { sandboxId: id, state: gone ? "stopped" : "unknown", terminationConfirmed: gone, cleanupConfirmed: gone } };
  }
}
