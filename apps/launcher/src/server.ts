import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execa } from "execa";
import { loadHostCommands, resolveHostCommand, type HostCommandEffect } from "./host-commands";
import { isEgressHost, pruneEgressGrants, removeEgressGrant, writeEgressGrant } from "./egress-proxy";
import { ENGINE_IMAGE, EngineSandboxes } from "./engine-sandbox";

interface Sandbox { id: string; containerId: string; profile: string; requestHash: string; grantId?: string }
const sandboxes = new Map<string, Sandbox>();

const PROFILES = new Set(["agent", "privileged-tool", "evaluator"]);
// The engine image only ever runs through the engine-sandbox routes; the tool profiles cannot name it.
const TOOL_IMAGES = new Set(["brain-sandbox-agent", "brain-sandbox-tool", "brain-sandbox-evaluator"]);
const IMAGES = new Set([...TOOL_IMAGES, ENGINE_IMAGE]);

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

// Doc 20: the socket lives in a 0700 directory and carries a scoped token so a
// containerized supervisor (whose Unix peer identity does not survive that
// topology) still authenticates. The token is created owner-only at startup.
function loadOrCreateToken(socket: string, configured?: string): string {
  if (configured) return configured;
  const tokenPath = `${socket}.token`;
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  mkdirSync(dirname(tokenPath), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

// Recover the sandbox registry after a launcher restart: containers carry the
// brain.launcher label with their idempotency request, so live sandboxes are
// re-registered instead of leaking unmanaged (doc 20 reconcile requirement).
async function reconcileRegistry(grantsDir: string | undefined): Promise<void> {
  try {
    const listed = await execa("docker", ["ps", "--filter", "label=brain.launcher", "--format", "{{.Names}}\t{{.Label \"brain.launcher\"}}\t{{.Label \"brain.egress-grant\"}}"], { timeout: 15_000, reject: false });
    if (listed.exitCode !== 0) return;
    const live = new Set<string>();
    for (const line of listed.stdout.split("\n")) {
      const [name, label, grantId] = line.split("\t");
      if (!name || !label) continue;
      if (grantId) live.add(grantId);
      if (sandboxes.has(name)) continue;
      const profile = name.startsWith("brain-") ? (name.split("-")[1] ?? "agent") : "agent";
      sandboxes.set(name, { id: name, containerId: name, profile: PROFILES.has(profile) ? profile : "agent", requestHash: label, ...(grantId ? { grantId } : {}) });
    }
    // The egress grants of sandboxes that are gone (a crash between create and stop) are dropped with them.
    if (grantsDir) pruneEgressGrants(grantsDir, live);
  } catch { /* docker unreachable: the launcher still serves refusals */ }
}

export async function startLauncher(): Promise<void> {
  const socket = process.env["BRAIN_LAUNCHER_SOCKET"] ?? "/tmp/brain-launcher/launcher.sock";
  const expectedToken = loadOrCreateToken(socket, process.env["BRAIN_LAUNCHER_TOKEN"]);
  // Image digest pins (T21): "name=sha256:...,name=sha256:..." — when a pin is
  // configured for an allowlisted image, the local image must carry exactly
  // that RepoDigest before any container is created from it. A tag that
  // silently points at different bytes can never run.
  const imagePins = new Map<string, string>();
  for (const pair of (process.env["BRAIN_LAUNCHER_IMAGE_DIGESTS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq > 0) imagePins.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  // Operator-declared read-only data mounts (doc 20): "name=/host/path,...".
  // A sandbox request names a mount; it never supplies a host path, so a
  // workflow cannot smuggle a filesystem view the operator did not publish.
  const dataMounts = new Map<string, string>();
  for (const pair of (process.env["BRAIN_LAUNCHER_DATA_MOUNTS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq > 0) dataMounts.set(pair.slice(0, eq).trim(), resolve(pair.slice(eq + 1).trim()));
  }
  // Where the egress proxy reads its per-sandbox grants (ADR 0037); without it no sandbox gets a network.
  const egressGrantsDir = process.env["BRAIN_LAUNCHER_EGRESS_GRANTS_DIR"] ? resolve(process.env["BRAIN_LAUNCHER_EGRESS_GRANTS_DIR"]) : undefined;
  // Operator-owned allowlist of named host commands (ADR 0021): "name" -> fixed argv, never a caller-supplied command line.
  const hostCommands = loadHostCommands(process.env["BRAIN_LAUNCHER_HOST_COMMANDS"]);
  // Whether the local image is the bytes pinned for it, when a pin is configured: the reason it may not run, or undefined.
  const verifyPinned = async (image: string): Promise<string | undefined> => {
    const pin = imagePins.get(image);
    if (!pin) return undefined;
    const inspect = await execa("docker", ["image", "inspect", image, "--format", "{{json .RepoDigests}}"], { timeout: 15_000, reject: false });
    let digests: string[] = [];
    try { digests = JSON.parse(String(inspect.stdout)) as string[]; } catch { digests = []; }
    return inspect.exitCode !== 0 || !digests.some((d) => d.endsWith(pin)) ? `image ${image} does not match pinned ${pin}; refusing to run unpinned bytes` : undefined;
  };
  // Engine sandboxes (ADR 0067): the host directory holding every attempt's engine state, who the engine runs as there, and how long a
  // sandbox may go unspoken to before it is stopped (a runner that died leaves no container holding a network grant).
  const engineIdleMs = Number(process.env["BRAIN_LAUNCHER_ENGINE_IDLE_MS"] ?? 90_000);
  const engineUser = process.env["BRAIN_LAUNCHER_ENGINE_USER"] ?? `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
  if (!/^\d+:\d+$/u.test(engineUser)) throw new Error("BRAIN_LAUNCHER_ENGINE_USER must be uid:gid");
  const engineSandboxes = new EngineSandboxes({
    stateRoot: process.env["BRAIN_LAUNCHER_ENGINE_STATE_ROOT"] ? resolve(process.env["BRAIN_LAUNCHER_ENGINE_STATE_ROOT"]) : undefined,
    egressGrantsDir, user: engineUser, idleMs: Number.isFinite(engineIdleMs) && engineIdleMs > 0 ? engineIdleMs : 90_000, verifyImage: verifyPinned,
  });
  mkdirSync(dirname(socket), { recursive: true });
  // The single-use ledger of privileged invocations survives a restart of the launcher.
  const ledgerPath = `${socket}.effects`;
  const usedInvocations = new Set<string>(existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean) : []);
  if (existsSync(socket)) unlinkSync(socket);
  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/v1/health") {
        let docker = false;
        try { const r = await execa("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 }); docker = r.exitCode === 0; } catch { docker = false; }
        // Docker answering is not enough: a step fails on the first container if the image it runs in was never built on this machine.
        const missingImages: string[] = [];
        if (docker) {
          for (const image of IMAGES) {
            try { if ((await execa("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { timeout: 5000, reject: false })).exitCode !== 0) missingImages.push(image); } catch { missingImages.push(image); }
          }
        }
        json(res, 200, { docker, missingImages, profiles: [...PROFILES], images: [...IMAGES], pinnedImages: [...imagePins.keys()], dataMounts: [...dataMounts.keys()], hostCommands: [...hostCommands.entries()].map(([name, c]) => ({ name, effect: c.effect })) });
        return;
      }
      const auth = req.headers.authorization ?? "";
      if (!expectedToken || auth !== `Bearer ${expectedToken}`) { json(res, 401, { error: "launcher token required" }); return; }
      if (req.method === "POST" && url === "/v1/host-commands/run") {
        const b = await body(req);
        for (const k of Object.keys(b)) if (!["command", "args", "allow", "invocationId"].includes(k)) { json(res, 422, { error: `field ${k} forbidden` }); return; }
        const allow: HostCommandEffect = b["allow"] === "privileged" ? "privileged" : "read";
        const resolved = resolveHostCommand(hostCommands, String(b["command"] ?? ""), b["args"], allow);
        if (!resolved.ok) { json(res, resolved.status, { error: resolved.error }); return; }
        if (allow === "privileged") {
          // A privileged command runs at most once per invocation (ADR 0024): the id of every run is written down before the command
          // starts, so a replayed request, a retry after a crash, or a second runner asking again is refused here as well.
          const invocationId = String(b["invocationId"] ?? "");
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(invocationId)) { json(res, 422, { error: "a privileged command needs the invocationId of its permit" }); return; }
          if (usedInvocations.has(invocationId)) { json(res, 409, { error: `invocation ${invocationId} already ran; a privileged command runs once` }); return; }
          usedInvocations.add(invocationId);
          appendFileSync(ledgerPath, `${invocationId}\n`, { mode: 0o600 });
        }
        const [bin, ...rest] = resolved.argv as string[];
        const result = await execa(bin!, rest, {
          timeout: resolved.command.timeoutMs, maxBuffer: 256 * 1024, extendEnv: false, shell: false, reject: false,
          env: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/tmp", LANG: "C.UTF-8" },
        });
        json(res, 200, { exitCode: result.exitCode ?? -1, stdout: String(result.stdout).slice(0, 64 * 1024), stderr: String(result.stderr).slice(0, 4096), timedOut: result.timedOut === true });
        return;
      }
      if (req.method === "POST" && url === "/v1/sandboxes") {
        const b = await body(req);
        const profile = String(b["profile"] ?? "");
        const image = String(b["image"] ?? "");
        const requestId = String(b["requestId"] ?? "");
        if (!PROFILES.has(profile)) { json(res, 422, { error: "unknown profile" }); return; }
        if (!TOOL_IMAGES.has(image)) { json(res, 422, { error: "image not preinstalled" }); return; }
        // No arbitrary argv/mounts/env: reject smuggled fields. toolsDir is the
        // one permitted tool mount (read-only at /tools); dataMounts may only
        // name an operator-declared path and is always mounted read-only.
        for (const k of Object.keys(b)) {
          if (!["profile", "image", "requestId", "worktreeId", "cpuMillicores", "memoryMb", "network", "egressHosts", "toolsDir", "dataMounts"].includes(k)) { json(res, 422, { error: `field ${k} forbidden` }); return; }
        }
        const requestedMounts = Array.isArray(b["dataMounts"]) ? b["dataMounts"].map((m) => String(m)) : [];
        if (requestedMounts.length > 8) { json(res, 422, { error: "too many dataMounts" }); return; }
        const mounts: string[] = [];
        for (const name of requestedMounts) {
          if (!/^[a-z][a-z0-9-]*$/u.test(name)) { json(res, 422, { error: `dataMount name ${name} invalid` }); return; }
          const host = dataMounts.get(name);
          if (!host) { json(res, 422, { error: `dataMount ${name} is not operator-declared` }); return; }
          if (!existsSync(host)) { json(res, 409, { error: `dataMount ${name} path is absent on this host` }); return; }
          mounts.push("-v", `${host}:/data/${name}:ro`);
        }
        // The network a sandbox gets is the proxy's, and only for the hosts named here (ADR 0037): no hosts means no network, and a tool that
        // runs a privileged effect never has one.
        const requestedHosts = Array.isArray(b["egressHosts"]) ? b["egressHosts"].map((h) => String(h)) : [];
        if (requestedHosts.length > 100 || requestedHosts.some((h) => !isEgressHost(h))) { json(res, 422, { error: "egressHosts must be at most 100 lower-case host or host:port entries" }); return; }
        const wantsNet = String(b["network"] ?? "none") !== "none";
        if (wantsNet !== (requestedHosts.length > 0)) { json(res, 422, { error: wantsNet ? "a sandbox with a network must name the egressHosts it may reach" : "egressHosts need network internal" }); return; }
        if (wantsNet && profile === "privileged-tool") { json(res, 422, { error: "a privileged tool never gets a network" }); return; }
        if (wantsNet && !egressGrantsDir) { json(res, 409, { error: "the egress proxy is not configured on this launcher (BRAIN_LAUNCHER_EGRESS_GRANTS_DIR)" }); return; }
        const unpinned = await verifyPinned(image);
        if (unpinned) { json(res, 409, { error: unpinned }); return; }
        const prior = [...sandboxes.values()].find((s) => s.requestHash === requestId);
        if (prior) { json(res, 200, { sandboxId: prior.id, containerId: prior.containerId, profile: prior.profile, state: "running", terminationConfirmed: false, cleanupConfirmed: false }); return; }
        const name = `brain-${profile}-${Date.now().toString(36)}`;
        const network = wantsNet ? "brain-internal" : "none";
        if (network === "brain-internal") {
          await execa("docker", ["network", "create", "--internal", "brain-internal"], { timeout: 15_000, reject: false });
        }
        // The sandbox's own credentials for the proxy: what they reach is the grant written here, and the grant goes when the sandbox does.
        const grant = wantsNet ? writeEgressGrant(egressGrantsDir!, requestedHosts) : undefined;
        const proxyUrl = grant ? `http://${grant.id}:${grant.token}@brain-egress-proxy:18080` : undefined;
        const proxyEnv = proxyUrl
          ? ["-e", `http_proxy=${proxyUrl}`, "-e", `https_proxy=${proxyUrl}`, "-e", `HTTP_PROXY=${proxyUrl}`, "-e", `HTTPS_PROXY=${proxyUrl}`, "-e", "no_proxy=127.0.0.1,localhost"]
          : [];
        const toolsDir = typeof b["toolsDir"] === "string" && b["toolsDir"] ? ["-v", `${String(b["toolsDir"])}:/tools:ro`] : [];
        const args = ["run", "-d", "--name", name, "--network", network, ...proxyEnv, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
          "--cpus", String(Math.max(0.1, Number(b["cpuMillicores"] ?? 500) / 1000)), "--memory", `${Number(b["memoryMb"] ?? 512)}m`, "--pids-limit", "128",
          "--label", `brain.launcher=request:${requestId}`, ...(grant ? ["--label", `brain.egress-grant=${grant.id}`] : []), ...toolsDir, ...mounts, image, "sleep", "infinity"];
        const created = await execa("docker", args, { timeout: 60_000, reject: false });
        if (created.exitCode !== 0) { if (grant) removeEgressGrant(egressGrantsDir!, grant.id); json(res, 503, { error: `docker run failed: ${String(created.stderr).slice(0, 500)}` }); return; }
        const containerId = String(created.stdout).trim();
        sandboxes.set(name, { id: name, containerId, profile, requestHash: requestId, ...(grant ? { grantId: grant.id } : {}) });
        json(res, 201, { sandboxId: name, containerId, profile, state: "running", terminationConfirmed: false, cleanupConfirmed: false });
        return;
      }
      if (req.method === "POST" && url === "/v1/engine-sandboxes") {
        const reply = await engineSandboxes.create(await body(req));
        json(res, reply.status, reply.body);
        return;
      }
      const engineUrl = new URL(url, "http://launcher");
      const enginePath = engineUrl.pathname.split("/");
      const engineMatch = enginePath.length === 5 && enginePath[1] === "v1" && enginePath[2] === "engine-sandboxes" && ["input", "output", "stop"].includes(enginePath[4] ?? "") ? [enginePath[3], enginePath[4]] : undefined;
      if (engineMatch) {
        const id = decodeURIComponent(engineMatch[0] ?? "");
        const query = engineUrl.searchParams;
        const reply = req.method === "POST" && engineMatch[1] === "input" ? engineSandboxes.input(id, await body(req, 4 * 1024 * 1024))
          : req.method === "POST" && engineMatch[1] === "stop" ? await engineSandboxes.stop(id, Number((await body(req))["graceMs"] ?? 5000))
          : req.method === "GET" && engineMatch[1] === "output" ? await engineSandboxes.output(id, Math.max(0, Number(query.get("after") ?? 0)), Number(query.get("waitMs") ?? 0))
          : { status: 404, body: { error: "not found" } };
        json(res, reply.status, reply.body);
        return;
      }
      const execMatch = url.match(/^\/v1\/sandboxes\/([^/]+)\/exec$/);
      if (req.method === "POST" && execMatch) {
        const id = decodeURIComponent(execMatch[1] ?? "");
        const sb = sandboxes.get(id);
        if (!sb) { json(res, 404, { error: "sandbox not found" }); return; }
        const b = await body(req);
        // Fixed argv: one bash invocation of a caller-provided script path
        // inside the container. Stdin is JSON tool input, bounded; output is
        // bounded so a runaway tool cannot grow launcher memory.
        if (b["argv"] !== undefined && JSON.stringify(b["argv"]) !== JSON.stringify(["/bin/bash"])) {
          json(res, 422, { error: "only /bin/bash script execution is permitted" }); return;
        }
        const script = String(b["script"] ?? "");
        if (!/^\/tools\/[A-Za-z0-9._/-]+$/.test(script) && !/^\/bin\//.test(script)) { json(res, 422, { error: "script must live under /tools or /bin" }); return; }
        const stdin = String(b["input"] ?? "");
        if (Buffer.byteLength(stdin, "utf8") > 64 * 1024) { json(res, 413, { error: "stdin too large" }); return; }
        const timeoutMs = Math.min(300_000, Math.max(1000, Number(b["timeoutMs"] ?? 60_000)));
        const result = await execa("docker", ["exec", "-i", sb.containerId, "/bin/bash", script], {
          input: stdin, timeout: timeoutMs, maxBuffer: 1024 * 1024, extendEnv: false,
          env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp", LANG: "C.UTF-8" },
          reject: false,
        });
        json(res, 200, {
          exitCode: result.exitCode,
          stdout: String(result.stdout).slice(0, 1024 * 1024),
          stderr: String(result.stderr).slice(0, 16_384),
          timedOut: result.timedOut === true,
        });
        return;
      }
      const stopMatch = url.match(/^\/v1\/sandboxes\/([^/]+)\/stop$/);
      if (req.method === "POST" && stopMatch) {
        const id = decodeURIComponent(stopMatch[1] ?? "");
        const sb = sandboxes.get(id);
        if (!sb) { json(res, 404, { error: "sandbox not found" }); return; }
        const b = await body(req);
        const grace = Math.min(10, Math.max(0, Number(b["graceMs"] ?? 5000) / 1000));
        await execa("docker", ["stop", "-t", String(grace), sb.containerId], { timeout: 30_000, reject: false });
        await execa("docker", ["rm", "-f", sb.containerId], { timeout: 30_000, reject: false });
        const check = await execa("docker", ["inspect", sb.containerId], { timeout: 10_000, reject: false });
        const gone = check.exitCode !== 0;
        if (gone) { sandboxes.delete(id); if (sb.grantId && egressGrantsDir) removeEgressGrant(egressGrantsDir, sb.grantId); }
        json(res, 200, { sandboxId: id, containerId: sb.containerId, profile: sb.profile, state: gone ? "stopped" : "unknown", terminationConfirmed: gone, cleanupConfirmed: gone });
        return;
      }
      const getMatch = url.match(/^\/v1\/sandboxes\/([^/]+)$/);
      if (req.method === "GET" && getMatch) {
        const id = decodeURIComponent(getMatch[1] ?? "");
        const sb = sandboxes.get(id);
        if (!sb) { json(res, 404, { error: "sandbox not found" }); return; }
        json(res, 200, { sandboxId: id, containerId: sb.containerId, profile: sb.profile, state: "running", terminationConfirmed: false, cleanupConfirmed: false });
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : "launcher error" });
    }
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await engineSandboxes.removeLeftovers();
  await reconcileRegistry(egressGrantsDir);
  engineSandboxes.startReaper();
  console.log(`Brain launcher listening on ${socket}`);
}
