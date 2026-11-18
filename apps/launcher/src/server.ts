import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { execa } from "execa";
import { pruneEgressGrants } from "./egress-proxy";
import { ENGINE_IMAGE, ENGINE_LABEL, EngineSandboxes } from "./engine-sandbox";
import { type HostCommandEffect, loadHostCommands, resolveHostCommand } from "./host-commands";
import { removeLeftovers, type SandboxOptions } from "./sandbox-common";
import { runTool, TOOL_IMAGE, TOOL_LABEL } from "./tool-sandbox";

/**
 * The trusted launcher: the one process that may start containers and run host commands for a runner. It listens on a Unix socket in an
 * owner-only folder and takes a scoped token. A request never carries an argv, a mount or an image: it names an attempt, a tool or an
 * operator-declared command, and the launcher decides the rest.
 *
 *   GET  /v1/health                         Docker up, sandbox images present, declared host commands
 *   POST /v1/tool-runs                      one run of a tool's run.sh in a tool sandbox (tool-sandbox.ts)
 *   POST /v1/host-commands/run              one operator-declared host command (host-commands.ts)
 *   POST /v1/engine-sandboxes               an engine's container for one attempt (engine-sandbox.ts)
 *   POST /v1/engine-sandboxes/:id/input     lines to the engine host
 *   GET  /v1/engine-sandboxes/:id/output    lines from it
 *   POST /v1/engine-sandboxes/:id/stop
 *
 * The launcher's environment variables, all of them:
 *   BRAIN_LAUNCHER_SOCKET              the socket (default /tmp/brain-launcher/launcher.sock); the token file is <socket>.token
 *   BRAIN_LAUNCHER_TOKEN               the token, instead of a generated one
 *   BRAIN_LAUNCHER_ATTEMPTS_ROOT       the runner's <state>/attempts folder on this host; without it no sandbox starts
 *   BRAIN_LAUNCHER_SANDBOX_USER        uid:gid sandboxes run as (default the launcher's own): the owner of the attempt folders
 *   BRAIN_LAUNCHER_EGRESS_GRANTS_DIR   where the egress proxy reads its grants; without it no sandbox gets a network
 *   BRAIN_LAUNCHER_HOST_COMMANDS       the operator's host-command file
 *   BRAIN_LAUNCHER_IMAGE_DIGESTS       image pins, "name=sha256:...,name=sha256:..."
 *   BRAIN_LAUNCHER_ENGINE_IDLE_MS      how long an engine sandbox may go unspoken to before it is stopped (default 90000)
 * The egress proxy is its own process (egress-proxy.ts) and reads BRAIN_PROXY_PORT, BRAIN_EGRESS_GRANTS_DIR and BRAIN_EGRESS_ALLOW_INTERNAL.
 */
const IMAGES = [TOOL_IMAGE, ENGINE_IMAGE] as const;

async function body(req: IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limit) throw new Error("payload too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** The folder of the socket and the token: owner-only, and this process's own. A folder that already existed is tightened, not trusted, and one that belongs to someone else is refused. */
function ownerOnlyFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const owner = process.getuid?.();
  if (owner !== undefined && statSync(folder).uid !== owner) throw new Error(`${folder} is not owned by the user the launcher runs as`);
  chmodSync(folder, 0o700);
}

/** Whether the Authorization header carries the token: compared in constant time (as digests, so the lengths never differ). */
function tokenMatches(header: string | undefined, token: string): boolean {
  const digest = (text: string): Buffer => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`));
}

/** The socket lives in an owner-only folder and carries a scoped token, so a runner in a container (whose Unix peer identity does not survive that) still authenticates. */
function loadOrCreateToken(socket: string, configured?: string): string {
  if (configured) return configured;
  const tokenPath = `${socket}.token`;
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

export async function startLauncher(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const socket = env["BRAIN_LAUNCHER_SOCKET"] ?? "/tmp/brain-launcher/launcher.sock";
  ownerOnlyFolder(dirname(socket));
  const expectedToken = loadOrCreateToken(socket, env["BRAIN_LAUNCHER_TOKEN"]);
  // Image pins: when one is configured for a sandbox image, the local image must carry exactly that digest before any container is
  // created from it, so a tag that silently points at other bytes never runs.
  const imagePins = new Map<string, string>();
  for (const pair of (env["BRAIN_LAUNCHER_IMAGE_DIGESTS"] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq > 0) imagePins.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const verifyImage = async (image: string): Promise<string | undefined> => {
    const pin = imagePins.get(image);
    if (!pin) return undefined;
    const inspect = await execa("docker", ["image", "inspect", image, "--format", "{{json .RepoDigests}}"], { timeout: 15_000, reject: false });
    let digests: string[] = [];
    try { digests = JSON.parse(String(inspect.stdout)) as string[]; } catch { digests = []; }
    return inspect.exitCode !== 0 || !digests.some((digest) => digest.endsWith(pin)) ? `image ${image} does not match pinned ${pin}; refusing to run unpinned bytes` : undefined;
  };
  const user = env["BRAIN_LAUNCHER_SANDBOX_USER"] ?? `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
  if (!/^\d+:\d+$/u.test(user)) throw new Error("BRAIN_LAUNCHER_SANDBOX_USER must be uid:gid");
  const egressGrantsDir = env["BRAIN_LAUNCHER_EGRESS_GRANTS_DIR"] ? resolve(env["BRAIN_LAUNCHER_EGRESS_GRANTS_DIR"]) : undefined;
  const sandboxes: SandboxOptions = { attemptsRoot: env["BRAIN_LAUNCHER_ATTEMPTS_ROOT"] ? resolve(env["BRAIN_LAUNCHER_ATTEMPTS_ROOT"]) : undefined, egressGrantsDir, user, verifyImage };
  const idleMs = Number(env["BRAIN_LAUNCHER_ENGINE_IDLE_MS"] ?? 90_000);
  const engineSandboxes = new EngineSandboxes({ ...sandboxes, idleMs: Number.isFinite(idleMs) && idleMs > 0 ? idleMs : 90_000 });
  const hostCommands = loadHostCommands(env["BRAIN_LAUNCHER_HOST_COMMANDS"]);
  // The single-use ledger of privileged commands survives a restart of the launcher.
  const ledgerPath = `${socket}.effects`;
  const usedInvocations = new Set<string>(existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean) : []);
  if (existsSync(socket)) unlinkSync(socket);

  const server = createServer(async (req, res) => {
    // A runner that stops waiting (its attempt was stopped, or it is gone) closes the connection: what ran for it stops with it.
    const gone = new AbortController();
    res.on("close", () => { if (!res.writableFinished) gone.abort(); });
    try {
      const url = new URL(req.url ?? "/", "http://launcher");
      if (req.method === "GET" && url.pathname === "/v1/health") {
        let docker = false;
        try { docker = (await execa("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 })).exitCode === 0; } catch { docker = false; }
        // Docker answering is not enough: a sandbox fails on its first container if its image was never built on this machine.
        const missingImages: string[] = [];
        if (docker) for (const image of IMAGES) if ((await execa("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { timeout: 5000, reject: false })).exitCode !== 0) missingImages.push(image);
        json(res, 200, { docker, missingImages, images: IMAGES, pinnedImages: [...imagePins.keys()], hostCommands: [...hostCommands.entries()].map(([name, command]) => ({ name, effect: command.effect })) });
        return;
      }
      if (!expectedToken || !tokenMatches(req.headers.authorization, expectedToken)) { json(res, 401, { error: "launcher token required" }); return; }
      if (req.method === "POST" && url.pathname === "/v1/host-commands/run") {
        const b = await body(req);
        for (const key of Object.keys(b)) if (!["command", "args", "allow", "invocationId"].includes(key)) { json(res, 422, { error: `field ${key} forbidden` }); return; }
        const allow: HostCommandEffect = b["allow"] === "privileged" ? "privileged" : "read";
        const resolved = resolveHostCommand(hostCommands, String(b["command"] ?? ""), b["args"], allow);
        if (!resolved.ok) { json(res, resolved.status, { error: resolved.error }); return; }
        if (allow === "privileged") {
          // A privileged command runs at most once per approved call: the id of every run is written down before the command starts, so
          // a replayed request, a retry after a crash, or a second runner asking again is refused here as well.
          const invocationId = String(b["invocationId"] ?? "");
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u.test(invocationId)) { json(res, 422, { error: "a privileged command needs the id of its approved call" }); return; }
          if (usedInvocations.has(invocationId)) { json(res, 409, { error: `call ${invocationId} already ran; a privileged command runs once` }); return; }
          usedInvocations.add(invocationId);
          appendFileSync(ledgerPath, `${invocationId}\n`, { mode: 0o600 });
        }
        const [bin, ...rest] = resolved.argv as string[];
        const result = await execa(bin!, rest, {
          timeout: resolved.command.timeoutMs, maxBuffer: 256 * 1024, extendEnv: false, shell: false, reject: false, cancelSignal: gone.signal,
          env: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/tmp", LANG: "C.UTF-8" },
        });
        json(res, 200, { exitCode: result.exitCode ?? -1, stdout: String(result.stdout).slice(0, 64 * 1024), stderr: String(result.stderr).slice(0, 4096), timedOut: result.timedOut === true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/tool-runs") {
        const reply = await runTool(sandboxes, await body(req), gone.signal);
        json(res, reply.status, reply.body);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/engine-sandboxes") {
        const reply = await engineSandboxes.create(await body(req));
        json(res, reply.status, reply.body);
        return;
      }
      const path = url.pathname.split("/");
      if (path.length === 5 && path[1] === "v1" && path[2] === "engine-sandboxes") {
        const id = decodeURIComponent(path[3] ?? "");
        const reply = req.method === "POST" && path[4] === "input" ? engineSandboxes.input(id, await body(req, 4 * 1024 * 1024))
          : req.method === "POST" && path[4] === "stop" ? await engineSandboxes.stop(id, Number((await body(req))["graceMs"] ?? 5000))
          : req.method === "GET" && path[4] === "output" ? await engineSandboxes.output(id, Math.max(0, Number(url.searchParams.get("after") ?? 0)), Number(url.searchParams.get("waitMs") ?? 0))
          : { status: 404, body: { error: "not found" } };
        json(res, reply.status, reply.body);
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : "launcher error" });
    }
  });
  await new Promise<void>((listening) => server.listen(socket, listening));
  // Nothing of an earlier launcher can be reattached: its containers go, and with them every grant at the proxy.
  await removeLeftovers(ENGINE_LABEL);
  await removeLeftovers(TOOL_LABEL);
  if (egressGrantsDir) pruneEgressGrants(egressGrantsDir, new Set());
  engineSandboxes.startReaper();
  console.log(`Brain launcher listening on ${socket}`);
}
