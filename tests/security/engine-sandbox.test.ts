import { request } from "node:http";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLauncher } from "../../apps/launcher/src/server";
import { ENGINE_PIDS_LIMIT, ENGINES, EngineSandboxes } from "../../apps/launcher/src/engine-sandbox";
import { SANDBOXABLE } from "../../apps/runner/src/engines/isolation";
import { LauncherClient } from "../../apps/runner/src/launcher-client";
import { decodeFrame, encodeFrame, type HostFrame } from "../../apps/runner/src/engines/sandbox-protocol";
import { scaled } from "../support/timing";

// ADR 0073 at the launcher's boundary: what `docker run` is given for an engine's sandbox (argv, limits, network, mount, secrets), what is
// refused before docker is called, and how a sandbox that cannot start or whose runner went quiet ends. `docker` is the stand-in in
// tests/support/fake-docker.mjs, which records its argv; no container runtime and no engine is started.

const FAKE_DOCKER = resolve("tests/support/fake-docker.mjs");
const ENV_NAMES = ["PATH", "FAKE_DOCKER_LOG", "FAKE_DOCKER_RUN_FAIL", "BRAIN_LAUNCHER_SOCKET", "BRAIN_LAUNCHER_ENGINE_STATE_ROOT", "BRAIN_LAUNCHER_EGRESS_GRANTS_DIR", "BRAIN_LAUNCHER_ENGINE_USER", "BRAIN_LAUNCHER_TOKEN", "BRAIN_LAUNCHER_TOKEN_FILE"] as const;
const saved: Record<string, string | undefined> = {};

let root = "";
let log = "";
let stateRoot = "";
let grants = "";
beforeEach(() => {
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  root = mkdtempSync(join(tmpdir(), "brain-engine-sandbox-"));
  mkdirSync(join(root, "bin"));
  copyFileSync(FAKE_DOCKER, join(root, "bin", "docker"));
  chmodSync(join(root, "bin", "docker"), 0o755);
  log = join(root, "docker.log");
  stateRoot = join(root, "engine-state");
  grants = join(root, "grants");
  mkdirSync(stateRoot);
  mkdirSync(grants);
  process.env["PATH"] = `${join(root, "bin")}:${process.env["PATH"] ?? ""}`;
  process.env["FAKE_DOCKER_LOG"] = log;
  delete process.env["FAKE_DOCKER_RUN_FAIL"];
  process.env["BRAIN_LAUNCHER_ENGINE_STATE_ROOT"] = stateRoot;
  process.env["BRAIN_LAUNCHER_EGRESS_GRANTS_DIR"] = grants;
  process.env["BRAIN_LAUNCHER_ENGINE_USER"] = "10002:10002";
});
afterEach(() => {
  for (const name of ENV_NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  rmSync(root, { recursive: true, force: true });
});

const dockerCalls = (): string[][] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : []);
const runCalls = (): string[][] => dockerCalls().filter((argv) => argv[0] === "run");

function unixJson(socket: string, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolveReply, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = request({ socketPath: socket, method, path, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); resolveReply({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }); });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function launcher(dir = "run"): Promise<{ socket: string; token: string; call: (method: string, path: string, body?: unknown) => ReturnType<typeof unixJson> }> {
  const socket = join(root, dir, "launcher.sock");
  process.env["BRAIN_LAUNCHER_SOCKET"] = socket;
  await startLauncher();
  const token = readFileSync(`${socket}.token`, "utf8").trim();
  return { socket, token, call: (method, path, body) => unixJson(socket, method, path, body, token) };
}

const create = (attemptId = "att-1", over: Record<string, unknown> = {}) => ({ engine: "pi", attemptId, requestId: `engine-${attemptId}-0`, cpuMillicores: 2000, memoryMb: 2048, egressHosts: ["api.example.com", "models.internal:8000"], ...over });

describe("an engine's sandbox is shaped by the launcher alone (ADR 0073)", () => {
  it("runs the engine image read-only with no capabilities, the reservation's limits, the proxy's network and one mount", async () => {
    mkdirSync(join(stateRoot, "att-1"));
    const l = await launcher();
    const made = await l.call("POST", "/v1/engine-sandboxes", create());
    expect(made.status).toBe(201);
    const [argv] = runCalls();
    expect(argv).toBeDefined();
    const args = argv!;
    // The image is last, the attempt runs interactively and leaves nothing behind.
    expect(args.slice(0, 2)).toEqual(["run", "-i"]);
    expect(args).toContain("--rm");
    expect(args.at(-1)).toBe("brain-sandbox-engine");
    const after = (flag: string): string => args[args.indexOf(flag) + 1]!;
    expect(args).toContain("--read-only");
    expect(after("--cap-drop")).toBe("ALL");
    expect(after("--security-opt")).toBe("no-new-privileges:true");
    expect(after("--cpus")).toBe("2");
    expect(after("--memory")).toBe("2048m");
    expect(after("--memory-swap")).toBe("2048m");
    expect(after("--pids-limit")).toBe(String(ENGINE_PIDS_LIMIT));
    expect(ENGINE_PIDS_LIMIT).toBe(512);
    expect(after("--user")).toBe("10002:10002");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--cap-add");
    expect(args).not.toContain("--device");
    // Only the attempt's state directory is mounted, writable; nothing else of the host is.
    const mounts = args.flatMap((arg, index) => (arg === "-v" ? [args[index + 1]!] : []));
    expect(mounts).toEqual([`${join(resolve(stateRoot), "att-1")}:/state:rw`]);
    expect(args.filter((arg) => arg === "--mount" || arg === "--volumes-from")).toEqual([]);
    // The network is the internal one and the proxy is the way out, with this sandbox's own grant of exactly the named hosts.
    expect(after("--network")).toBe("brain-internal");
    const grantFiles = readdirSync(grants);
    expect(grantFiles).toHaveLength(1);
    const grant = JSON.parse(readFileSync(join(grants, grantFiles[0]!), "utf8")) as { token: string; hosts: string[] };
    expect(grant.hosts).toEqual(["api.example.com", "models.internal:8000"]);
    // The credentials are in a 0600 env file docker read at `run`, never in the argv (where ps and docker inspect show them); the file is gone after.
    expect(args.join(" ")).not.toContain(grant.token);
    expect(args.some((arg) => arg.startsWith("https_proxy=") || arg.startsWith("HTTPS_PROXY="))).toBe(false);
    const envRuns = readFileSync(`${log}.envfile`, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { path: string; mode: number; text: string });
    expect(envRuns).toHaveLength(1);
    expect(args[args.indexOf("--env-file") + 1]).toBe(envRuns[0]!.path);
    expect(envRuns[0]!.mode).toBe(0o600);
    expect(envRuns[0]!.text).toContain(`https_proxy=http://${grantFiles[0]!.replace(/\.json$/u, "")}:${grant.token}@brain-egress-proxy:18080`);
    expect(existsSync(envRuns[0]!.path)).toBe(false);
    expect(args).toContain("NODE_USE_ENV_PROXY=1");
    expect(args).toContain(`brain.egress-grant=${grantFiles[0]!.replace(/\.json$/u, "")}`);
    // The engine to run is the launcher's own value, not a command the caller supplied.
    expect(args).toContain("BRAIN_ENGINE=pi");
    expect(args).not.toContain("sleep");
  }, scaled(60_000));

  it("a sandbox without hosts has no network at all", async () => {
    mkdirSync(join(stateRoot, "att-2"));
    const l = await launcher();
    expect((await l.call("POST", "/v1/engine-sandboxes", create("att-2", { egressHosts: [] }))).status).toBe(201);
    const args = runCalls()[0]!;
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args.some((arg) => /proxy/iu.test(arg))).toBe(false);
    expect(readdirSync(grants)).toEqual([]);
  }, scaled(60_000));

  it("refuses smuggled fields, unknown engines and bad bounds before docker is called", async () => {
    mkdirSync(join(stateRoot, "att-3"));
    const l = await launcher();
    for (const smuggled of [{ stateDir: "/" }, { env: { EVIL: "1" } }, { mounts: ["/:/host"] }, { image: "alpine" }, { cmd: ["sh"] }, { argv: ["sh"] }, { network: "host" }, { privileged: true }, { pidsLimit: 100000 }, { toolsDir: "/" }]) {
      const res = await l.call("POST", "/v1/engine-sandboxes", create("att-3", smuggled));
      expect(res.status, JSON.stringify(smuggled)).toBe(422);
      expect(String(res.json["error"])).toMatch(/forbidden/u);
    }
    const refused = async (body: Record<string, unknown>, status: number, message: RegExp) => {
      const res = await l.call("POST", "/v1/engine-sandboxes", body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(String(res.json["error"])).toMatch(message);
    };
    await refused(create("att-3", { engine: "fixture" }), 422, /unknown engine/u);
    await refused(create("att-3", { engine: "sh" }), 422, /unknown engine/u);
    await refused(create("../etc"), 422, /attemptId invalid/u);
    await refused(create("a/b"), 422, /attemptId invalid/u);
    await refused(create("att-3", { cpuMillicores: 0 }), 422, /cpuMillicores/u);
    await refused(create("att-3", { cpuMillicores: 1.5 }), 422, /cpuMillicores/u);
    await refused(create("att-3", { memoryMb: 1 }), 422, /memoryMb/u);
    await refused(create("att-3", { memoryMb: "2048" }), 422, /memoryMb/u);
    await refused(create("att-3", { egressHosts: ["https://example.com"] }), 422, /egressHosts must be/u);
    await refused(create("att-3", { egressHosts: ["Example.COM"] }), 422, /egressHosts must be/u);
    // A directory that is not the attempt's (absent, or a link out of the root) never mounts.
    await refused(create("att-absent"), 409, /state directory is absent/u);
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(stateRoot, "att-link"));
    await refused(create("att-link"), 409, /state directory is absent/u);
    expect(runCalls()).toEqual([]);
  }, scaled(60_000));

  it("refuses when the launcher has no engine state root or no proxy for the hosts", async () => {
    mkdirSync(join(stateRoot, "att-4"));
    delete process.env["BRAIN_LAUNCHER_ENGINE_STATE_ROOT"];
    const without = await launcher();
    const noRoot = await without.call("POST", "/v1/engine-sandboxes", create("att-4"));
    expect(noRoot.status).toBe(409);
    expect(String(noRoot.json["error"])).toMatch(/BRAIN_LAUNCHER_ENGINE_STATE_ROOT/u);
    process.env["BRAIN_LAUNCHER_ENGINE_STATE_ROOT"] = stateRoot;
    delete process.env["BRAIN_LAUNCHER_EGRESS_GRANTS_DIR"];
    const noProxy = await (await launcher("run2")).call("POST", "/v1/engine-sandboxes", create("att-4"));
    expect(noProxy.status).toBe(409);
    expect(String(noProxy.json["error"])).toMatch(/egress proxy is not configured/u);
    expect(runCalls()).toEqual([]);
  }, scaled(60_000));

  it("a sandbox that cannot start says why, leaves no grant, and nothing else runs the engine", async () => {
    mkdirSync(join(stateRoot, "att-5"));
    process.env["FAKE_DOCKER_RUN_FAIL"] = "Unable to find image 'brain-sandbox-engine:latest' locally";
    const l = await launcher();
    const res = await l.call("POST", "/v1/engine-sandboxes", create("att-5"));
    expect(res.status).toBe(503);
    expect(String(res.json["error"])).toContain("Unable to find image 'brain-sandbox-engine:latest' locally");
    expect(readdirSync(grants)).toEqual([]);
    expect(runCalls()).toHaveLength(1);
    // The tool profiles cannot be pointed at the engine image either.
    const viaTool = await l.call("POST", "/v1/sandboxes", { profile: "agent", image: "brain-sandbox-engine", requestId: "x" });
    expect(viaTool.status).toBe(422);
  }, scaled(60_000));

  it("hands lines to the engine host and back, and stopping it removes the container and its grant", async () => {
    mkdirSync(join(stateRoot, "att-6"));
    const l = await launcher();
    const made = await l.call("POST", "/v1/engine-sandboxes", create("att-6"));
    const id = String(made.json["sandboxId"]);
    // A repeated request is the same sandbox.
    expect(String((await l.call("POST", "/v1/engine-sandboxes", create("att-6"))).json["sandboxId"])).toBe(id);
    expect(runCalls()).toHaveLength(1);
    const line = encodeFrame({ id: 1, op: "dispose", sessionId: "s" }).trim();
    expect((await l.call("POST", `/v1/engine-sandboxes/${id}/input`, { lines: [line] })).status).toBe(200);
    const first = (await l.call("GET", `/v1/engine-sandboxes/${id}/output?after=0&waitMs=2000`)).json as { lines: string[]; next: number; closed: boolean };
    expect(first.lines.map((entry) => decodeFrame<HostFrame>(entry)?.type ?? entry)).toContain("ready");
    let seen = first.lines;
    let next = first.next;
    for (let tries = 0; tries < 20 && !seen.includes(`echo:${line}`); tries++) {
      const more = (await l.call("GET", `/v1/engine-sandboxes/${id}/output?after=${next}&waitMs=500`)).json as { lines: string[]; next: number };
      seen = [...seen, ...more.lines];
      next = more.next;
    }
    expect(seen).toContain(`echo:${line}`);
    // Oversized or malformed input is refused.
    expect((await l.call("POST", `/v1/engine-sandboxes/${id}/input`, { lines: [1] })).status).toBe(422);
    const stopped = await l.call("POST", `/v1/engine-sandboxes/${id}/stop`, { graceMs: 100 });
    expect(stopped.json).toMatchObject({ terminationConfirmed: true, cleanupConfirmed: true });
    const verbs = dockerCalls().map((argv) => argv.slice(0, 2).join(" "));
    expect(verbs).toContain(`stop -t`);
    expect(dockerCalls().some((argv) => argv[0] === "rm" && argv.includes(id))).toBe(true);
    expect(readdirSync(grants)).toEqual([]);
    expect((await l.call("GET", `/v1/engine-sandboxes/${id}/output?after=0`)).json).toMatchObject({ closed: true });
  }, scaled(60_000));

  it("works end to end through the runner's launcher client", async () => {
    mkdirSync(join(stateRoot, "att-7"));
    const l = await launcher();
    process.env["BRAIN_LAUNCHER_TOKEN"] = l.token;
    const client = new LauncherClient(l.socket);
    const channel = await client.open({ engine: "claude", attemptId: "att-7", requestId: "engine-att-7-0", cpuMillicores: 1000, memoryMb: 512, egressHosts: ["api.anthropic.com"] });
    await channel.send("hello");
    const seen: string[] = [];
    for await (const line of channel.lines()) { seen.push(line); if (line === "echo:hello") break; }
    expect(seen).toContain("echo:hello");
    expect((await channel.close()).terminationConfirmed).toBe(true);
    await expect(client.open({ engine: "claude", attemptId: "no-dir", requestId: "engine-no-dir-0", cpuMillicores: 1000, memoryMb: 512, egressHosts: [] })).rejects.toThrow(/engine sandbox create failed 409/u);
  }, scaled(60_000));
});

describe("the launcher and the runner agree on which engines run in a sandbox", () => {
  // The launcher is a separate trusted executable with no shared package, so its list is its own; this keeps the two from drifting.
  it("hosts exactly the engines the runner sends to a sandbox", () => {
    expect([...ENGINES].sort()).toEqual([...SANDBOXABLE].sort());
  });
});

describe("two creates of one request are one sandbox", () => {
  it("starts one container and one grant when the same request id arrives while the first is still starting", async () => {
    mkdirSync(join(stateRoot, "att-9"));
    process.env["FAKE_DOCKER_RUN_DELAY_MS"] = "300";
    try {
      const sandboxes = new EngineSandboxes({ stateRoot: resolve(stateRoot), egressGrantsDir: grants, user: "1:1", idleMs: 60_000, verifyImage: async () => undefined });
      const [first, second, third] = await Promise.all([sandboxes.create(create("att-9")), sandboxes.create(create("att-9")), sandboxes.create(create("att-9"))]);
      expect(first.status).toBe(201);
      expect(second.body["sandboxId"]).toBe(first.body["sandboxId"]);
      expect(third.body["sandboxId"]).toBe(first.body["sandboxId"]);
      expect(runCalls()).toHaveLength(1);
      expect(readdirSync(grants)).toHaveLength(1);
      await sandboxes.stop(String(first.body["sandboxId"]), 100);
      expect(readdirSync(grants)).toEqual([]);
    } finally { delete process.env["FAKE_DOCKER_RUN_DELAY_MS"]; }
  }, scaled(60_000));

  it("a failed start fails every waiting caller, leaves no grant, and a retry starts afresh", async () => {
    mkdirSync(join(stateRoot, "att-10"));
    process.env["FAKE_DOCKER_RUN_FAIL"] = "no image";
    const sandboxes = new EngineSandboxes({ stateRoot: resolve(stateRoot), egressGrantsDir: grants, user: "1:1", idleMs: 60_000, verifyImage: async () => undefined });
    const both = await Promise.all([sandboxes.create(create("att-10")), sandboxes.create(create("att-10"))]);
    expect(both.map((reply) => reply.status)).toEqual([503, 503]);
    expect(runCalls()).toHaveLength(1);
    expect(readdirSync(grants)).toEqual([]);
    delete process.env["FAKE_DOCKER_RUN_FAIL"];
    expect((await sandboxes.create(create("att-10"))).status).toBe(201);
    expect(runCalls()).toHaveLength(2);
  }, scaled(60_000));
});

describe("a sandbox whose runner went quiet does not outlive it", () => {
  it("stops a sandbox nobody has spoken to within the idle time, and its grant goes with it", async () => {
    mkdirSync(join(stateRoot, "att-8"));
    const sandboxes = new EngineSandboxes({ stateRoot: resolve(stateRoot), egressGrantsDir: grants, user: "1:1", idleMs: 1000, verifyImage: async () => undefined });
    const made = await sandboxes.create(create("att-8"));
    expect(made.status).toBe(201);
    expect(readdirSync(grants)).toHaveLength(1);
    await sandboxes.reap(Date.now() + 500);
    expect(dockerCalls().some((argv) => argv[0] === "stop")).toBe(false);
    await sandboxes.reap(Date.now() + 5000);
    expect(dockerCalls().some((argv) => argv[0] === "stop" && argv.includes(String(made.body["sandboxId"])))).toBe(true);
    expect(readdirSync(grants)).toEqual([]);
  }, scaled(60_000));
});
