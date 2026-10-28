import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execa } from "execa";

interface Sandbox { id: string; containerId: string; profile: string; requestHash: string }
const sandboxes = new Map<string, Sandbox>();

const PROFILES = new Set(["agent", "privileged-tool", "evaluator"]);
const IMAGES = new Set(["brain-sandbox-agent", "brain-sandbox-tool", "brain-sandbox-evaluator"]);

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > 256 * 1024) throw new Error("payload too large");
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
async function reconcileRegistry(): Promise<void> {
  try {
    const listed = await execa("docker", ["ps", "--filter", "label=brain.launcher", "--format", "{{.Names}}\t{{.Label \"brain.launcher\"}}"], { timeout: 15_000, reject: false });
    if (listed.exitCode !== 0) return;
    for (const line of listed.stdout.split("\n")) {
      const [name, label] = line.split("\t");
      if (!name || !label) continue;
      if (sandboxes.has(name)) continue;
      const profile = name.startsWith("brain-") ? (name.split("-")[1] ?? "agent") : "agent";
      sandboxes.set(name, { id: name, containerId: name, profile: PROFILES.has(profile) ? profile : "agent", requestHash: label });
    }
  } catch { /* docker unreachable: the launcher still serves refusals */ }
}

export async function startLauncher(): Promise<void> {
  const socket = process.env["BRAIN_LAUNCHER_SOCKET"] ?? "/tmp/brain-launcher/launcher.sock";
  const expectedToken = loadOrCreateToken(socket, process.env["BRAIN_LAUNCHER_TOKEN"]);
  mkdirSync(dirname(socket), { recursive: true });
  if (existsSync(socket)) unlinkSync(socket);
  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/v1/health") {
        let docker = false;
        try { const r = await execa("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 }); docker = r.exitCode === 0; } catch { docker = false; }
        json(res, 200, { docker, profiles: [...PROFILES], images: [...IMAGES] });
        return;
      }
      const auth = req.headers.authorization ?? "";
      if (!expectedToken || auth !== `Bearer ${expectedToken}`) { json(res, 401, { error: "launcher token required" }); return; }
      if (req.method === "POST" && url === "/v1/sandboxes") {
        const b = await body(req);
        const profile = String(b["profile"] ?? "");
        const image = String(b["image"] ?? "");
        const requestId = String(b["requestId"] ?? "");
        if (!PROFILES.has(profile)) { json(res, 422, { error: "unknown profile" }); return; }
        if (!IMAGES.has(image)) { json(res, 422, { error: "image not preinstalled" }); return; }
        // No arbitrary argv/mounts/env: reject smuggled fields. toolsDir is the
        // one permitted mount and is always read-only at /tools inside.
        for (const k of Object.keys(b)) {
          if (!["profile", "image", "requestId", "worktreeId", "cpuMillicores", "memoryMb", "network", "toolsDir"].includes(k)) { json(res, 422, { error: `field ${k} forbidden` }); return; }
        }
        const prior = [...sandboxes.values()].find((s) => s.requestHash === requestId);
        if (prior) { json(res, 200, { sandboxId: prior.id, containerId: prior.containerId, profile: prior.profile, state: "running", terminationConfirmed: false, cleanupConfirmed: false }); return; }
        const name = `brain-${profile}-${Date.now().toString(36)}`;
        // Egress policy by profile: privileged tools never get a network.
        // Agent/evaluator sandboxes may join the internal allowlist network;
        // the proxy is the only member with an external uplink (operator-run,
        // see proxy/allowlist_proxy.py). Any non-"none" request still lands
        // on the internal network, never a caller-named network.
        const wantsNet = String(b["network"] ?? "none") !== "none";
        const network = profile === "privileged-tool" ? "none" : wantsNet ? "brain-internal" : "none";
        if (network === "brain-internal") {
          await execa("docker", ["network", "create", "--internal", "brain-internal"], { timeout: 15_000, reject: false });
        }
        const proxyEnv = network === "brain-internal"
          ? ["-e", "http_proxy=http://brain-egress-proxy:18080", "-e", "https_proxy=http://brain-egress-proxy:18080",
             "-e", "HTTP_PROXY=http://brain-egress-proxy:18080", "-e", "HTTPS_PROXY=http://brain-egress-proxy:18080",
             "-e", "no_proxy=127.0.0.1,localhost"]
          : [];
        const toolsDir = typeof b["toolsDir"] === "string" && b["toolsDir"] ? ["-v", `${String(b["toolsDir"])}:/tools:ro`] : [];
        const args = ["run", "-d", "--name", name, "--network", network, ...proxyEnv, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
          "--cpus", String(Math.max(0.1, Number(b["cpuMillicores"] ?? 500) / 1000)), "--memory", `${Number(b["memoryMb"] ?? 512)}m`, "--pids-limit", "128",
          "--label", `brain.launcher=request:${requestId}`, ...toolsDir, image, "sleep", "infinity"];
        const created = await execa("docker", args, { timeout: 60_000, reject: false });
        if (created.exitCode !== 0) { json(res, 503, { error: `docker run failed: ${String(created.stderr).slice(0, 500)}` }); return; }
        const containerId = String(created.stdout).trim();
        sandboxes.set(name, { id: name, containerId, profile, requestHash: requestId });
        json(res, 201, { sandboxId: name, containerId, profile, state: "running", terminationConfirmed: false, cleanupConfirmed: false });
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
        if (gone) sandboxes.delete(id);
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
  await reconcileRegistry();
  console.log(`Brain launcher listening on ${socket}`);
}
