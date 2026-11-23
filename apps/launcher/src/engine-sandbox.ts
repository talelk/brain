import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { execa } from "execa";
import { removeEgressGrant } from "./egress-proxy";
import { attemptFolder, egressHosts, hardening, isDirectory, network, refuse, type Reply, type SandboxOptions, slug } from "./sandbox-common";

/**
 * Engine sandboxes: one container per attempt that runs an engine's host process, with its stdin and stdout held by the launcher and
 * handed to the runner as lines. The container's shape is decided here and only here: the request names the engine, the attempt, the
 * reservation, how the working copy is mounted and the hosts, and nothing else of it. Inside, the attempt's folders are `/work` (the
 * working copy: read-write when the agent's native tools are `all`, read-only for `read`, absent for `none`), `/out` and `/state`.
 */
export const ENGINE_IMAGE = "brain-sandbox-engine";
export const ENGINE_LABEL = "brain.engine-sandbox";
const ENGINES: ReadonlySet<string> = new Set(["pi", "claude", "opencode", "codex"]);
/** Engines start threads and child processes (a shell, an ACP agent): more than a tool's 128, still a hard bound. */
const ENGINE_PIDS_LIMIT = 512;
const ENGINE_FIELDS = ["engine", "attemptId", "requestId", "cpuMillicores", "memoryMb", "egressHosts", "work"] as const;
const WORK_MODES = new Set(["none", "ro", "rw"]);
const READY = /^@brain-engine \{"type":"ready"\}$/u;

interface EngineSandboxShape {
  readonly name: string;
  readonly requestId: string;
  readonly cpuMillicores: number;
  readonly memoryMb: number;
  /** The host folder of this attempt, already checked to be under the operator's root. */
  readonly attemptDirectory: string;
  readonly work: "none" | "ro" | "rw";
  /** `uid:gid` the engine runs as: the owner of the attempt's folders. */
  readonly user: string;
  readonly network: readonly string[];
}

/** The `docker run` argv of an engine sandbox: nothing in it comes from the caller except the values named in the shape. */
function engineSandboxArgs(shape: EngineSandboxShape): string[] {
  const work = shape.work === "none" ? [] : ["-v", `${join(shape.attemptDirectory, "work")}:/work:${shape.work}`];
  return ["run", "-i", "--rm", "--name", shape.name, ...shape.network,
    ...hardening(shape.cpuMillicores, shape.memoryMb, ENGINE_PIDS_LIMIT, shape.user, 256),
    ...work, "-v", `${join(shape.attemptDirectory, "out")}:/out:rw`, "-v", `${join(shape.attemptDirectory, "state")}:/state:rw`, "-w", shape.work === "none" ? "/state" : "/work",
    "-e", "BRAIN_ENGINE_HOST=1", "-e", "HOME=/state/home",
    "--label", `${ENGINE_LABEL}=${shape.requestId}`,
    ENGINE_IMAGE];
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

export interface EngineSandboxOptions extends SandboxOptions {
  /** A sandbox its runner has not spoken to for this long is stopped: a crashed runner leaves no container holding a network grant. */
  readonly idleMs: number;
}

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
    const requestId = String(body["requestId"] ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(requestId)) return refuse(422, "requestId invalid");
    const cpu = body["cpuMillicores"];
    const memory = body["memoryMb"];
    if (typeof cpu !== "number" || !Number.isInteger(cpu) || cpu < 100 || cpu > 64_000) return refuse(422, "cpuMillicores must be an integer from 100 to 64000");
    if (typeof memory !== "number" || !Number.isInteger(memory) || memory < 128 || memory > 262_144) return refuse(422, "memoryMb must be an integer from 128 to 262144");
    const work = String(body["work"] ?? "");
    if (!WORK_MODES.has(work)) return refuse(422, "work must be none, ro or rw");
    const hosts = egressHosts(body["egressHosts"], this.options.egressGrantsDir);
    if (!hosts.ok) return hosts.reply;
    const folder = attemptFolder(this.options.attemptsRoot, String(body["attemptId"] ?? ""));
    if (!folder.ok) return folder.reply;
    if (!["work", "out", "state"].every((name) => isDirectory(join(folder.directory, name)))) return refuse(409, "the attempt's work, out and state folders are absent on this host");
    const unverified = await this.options.verifyImage(ENGINE_IMAGE);
    if (unverified) return refuse(409, unverified);
    const prior = [...this.live.values()].find((sandbox) => sandbox.requestId === requestId && !sandbox.exited);
    if (prior) return { status: 200, body: { sandboxId: prior.id } };

    const name = `brain-engine-${slug(requestId)}-${Date.now().toString(36)}`;
    const net = await network(hosts.hosts, this.options.egressGrantsDir);
    const args = engineSandboxArgs({ name, requestId, cpuMillicores: cpu, memoryMb: memory, attemptDirectory: folder.directory, work: work as "none" | "ro" | "rw", user: this.options.user, network: net.args });
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const sandbox: EngineSandbox = { id: name, requestId, child, grantId: net.grantId, lines: [], base: 0, exited: false, stderr: "", lastSeenMs: Date.now(), notify: new Set() };
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
      net.release();
      return refuse(503, `docker run failed: ${(sandbox.stderr || (error instanceof Error ? error.message : "")).trim().slice(-500)}`);
    } finally { clearTimeout(timer); net.started(); }
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
