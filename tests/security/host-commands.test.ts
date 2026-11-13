import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHostCommands, resolveHostCommand } from "../../apps/launcher/src/host-commands";
import { startLauncher } from "../../apps/launcher/src/server";
import { brokerRead } from "../../apps/runner/src/tools/broker-read";
import { parseToolDataMounts } from "../../apps/runner/src/supervisor";
import { failedToolMessage } from "../../apps/runner/src/tools/invoke";

const shipped = parseHostCommands(readFileSync("scripts/demo/host-commands.json", "utf8"));

describe("operator host-command allowlist (ADR 0021)", () => {
  it("accepts every shipped command with valid arguments and builds a fixed argv", () => {
    expect(resolveHostCommand(shipped, "docker.logs", { lines: "50", container: "brain-governor-1" }, "read")).toMatchObject({ ok: true, argv: ["docker", "logs", "--tail", "50", "brain-governor-1"] });
    expect(resolveHostCommand(shipped, "http.head-public", { host: "brain.mykeyrus.tn" }, "read")).toMatchObject({ ok: true, argv: ["curl", "-sSI", "--max-time", "8", "https://brain.mykeyrus.tn/"] });
    expect(resolveHostCommand(shipped, "host.df", {}, "read")).toMatchObject({ ok: true });
    expect(resolveHostCommand(shipped, "http.check-demos", {}, "read")).toMatchObject({ ok: true });
    expect(resolveHostCommand(shipped, "http.check-demos", { host: "evil.example.com" }, "read")).toMatchObject({ ok: false, status: 422 });
  });
  it.each([
    ["an undeclared command", "rm", {}, 404],
    ["an unknown argument", "host.df", { path: "/etc" }, 422],
    ["a missing argument", "docker.logs", { lines: "10" }, 422],
    ["a flag smuggled as a value", "docker.logs", { lines: "10", container: "--privileged" }, 422],
    ["shell metacharacters", "docker.logs", { lines: "10", container: "a;rm -rf /" }, 422],
    ["a path traversal in a unit", "systemd.status", { unit: "../../etc/passwd.service" }, 422],
    ["a non-demo public host", "http.head-public", { host: "evil.example.com" }, 422],
    ["a host with credentials", "http.head-public", { host: "x@evil.mykeyrus.tn" }, 422],
    ["a non-numeric port", "http.head-local", { port: "80; id" }, 422],
  ])("refuses %s", (_label, name, args, status) => {
    expect(resolveHostCommand(shipped, name, args, "read")).toMatchObject({ ok: false, status });
  });
  it("never lets a read caller run a privileged command, nor a privileged caller a read command", () => {
    const table = parseHostCommands(JSON.stringify({ commands: { "demo.restart": { effect: "privileged", argv: ["true"] }, "demo.look": { effect: "read", argv: ["true"] } } }));
    expect(resolveHostCommand(table, "demo.restart", {}, "read")).toMatchObject({ ok: false, status: 403 });
    expect(resolveHostCommand(table, "demo.restart", {}, "privileged")).toMatchObject({ ok: true });
    expect(resolveHostCommand(table, "demo.look", {}, "privileged")).toMatchObject({ ok: false, status: 403 });
  });
  it("rejects a malformed operator file instead of loading part of it", () => {
    expect(() => parseHostCommands(JSON.stringify({ commands: { "a.b": { effect: "read", argv: ["x", "{p}"] } } }))).toThrow(/no pattern/);
    expect(() => parseHostCommands(JSON.stringify({ commands: { "a.b": { effect: "read", argv: ["x", "{p}"], args: { p: "[a-z]+" } } } }))).toThrow(/anchored/);
    expect(() => parseHostCommands(JSON.stringify({ commands: { "a.b": { effect: "write", argv: ["x"] } } }))).toThrow(/effect/);
  });
});

describe("per-tool data mounts on the runner", () => {
  it("gives a mount only to the tool that was named and ignores malformed entries", () => {
    const mounts = parseToolDataMounts("host.read=srv+logs, csv.query=cv-data ,broken,=x,host.exec=/etc,two=BAD");
    expect(mounts.get("host.read")).toEqual(["srv", "logs"]);
    expect(mounts.get("csv.query")).toEqual(["cv-data"]);
    expect(mounts.has("host.exec")).toBe(false);
    expect(mounts.has("two")).toBe(false);
    expect(mounts.get("web.fetch")).toBeUndefined();
  });
});

describe("host.exec broker", () => {
  const binding = { release: { id: "host.exec", digest: "sha256:x" } } as never;
  it("fails plainly without a launcher and runs nothing", async () => {
    expect(await brokerRead(binding, { command: "host.df" }, "att", {} as never)).toMatchObject({ ok: false });
  });
  it("passes only a name and text arguments to the launcher, as a read call", async () => {
    const calls: unknown[] = [];
    const launcher = { hostCommand: async (...args: unknown[]) => { calls.push(args); return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false }; } };
    const result = await brokerRead(binding, { command: "docker.logs", args: { lines: "5", container: "x" } }, "att", {} as never, launcher as never);
    expect(result).toMatchObject({ ok: true, data: { command: "docker.logs", exitCode: 0, stdout: "ok" } });
    expect(calls).toEqual([["docker.logs", { lines: "5", container: "x" }, "read"]]);
    expect(await brokerRead(binding, { command: "docker.logs", args: { lines: 5 } }, "att", {} as never, launcher as never)).toMatchObject({ ok: false });
  });
});

function unixJson(socket: string, path: string, body: unknown, token: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request({ socketPath: socket, method: "POST", path, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), authorization: `Bearer ${token}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

describe("launcher host-command endpoint", () => {
  const root = join(tmpdir(), `brain-host-commands-${Date.now()}`);
  const socket = join(root, "run", "launcher.sock");
  beforeAll(async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "commands.json"), JSON.stringify({ commands: {
      "demo.echo": { effect: "read", argv: ["echo", "{word}"], args: { word: "^[a-z]{1,10}$" } },
      "demo.restart": { effect: "privileged", argv: ["echo", "restarted"] },
    } }));
    process.env["BRAIN_LAUNCHER_SOCKET"] = socket;
    process.env["BRAIN_LAUNCHER_HOST_COMMANDS"] = join(root, "commands.json");
    await startLauncher();
  });
  afterAll(() => { delete process.env["BRAIN_LAUNCHER_HOST_COMMANDS"]; });
  const token = () => readFileSync(`${socket}.token`, "utf8").trim();
  it("needs the launcher token", async () => {
    expect((await unixJson(socket, "/v1/host-commands/run", { command: "demo.echo", args: { word: "hi" } }, "wrong")).status).toBe(401);
  });
  it("runs a declared read command, refuses privileged and unknown ones, and rejects extra fields", async () => {
    const ok = await unixJson(socket, "/v1/host-commands/run", { command: "demo.echo", args: { word: "hello" }, allow: "read" }, token());
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ exitCode: 0, stdout: "hello", timedOut: false });
    expect((await unixJson(socket, "/v1/host-commands/run", { command: "demo.restart", allow: "read" }, token())).status).toBe(403);
    expect((await unixJson(socket, "/v1/host-commands/run", { command: "nope.x", allow: "read" }, token())).status).toBe(404);
    expect((await unixJson(socket, "/v1/host-commands/run", { command: "demo.echo", args: { word: "a b" }, allow: "read" }, token())).status).toBe(422);
    expect((await unixJson(socket, "/v1/host-commands/run", { command: "demo.echo", args: { word: "x" }, argv: ["rm"] }, token())).status).toBe(422);
  });
  it("runs a privileged command once per invocation id (ADR 0024), and only with one", async () => {
    const noId = await unixJson(socket, "/v1/host-commands/run", { command: "demo.restart", allow: "privileged" }, token());
    expect(noId.status).toBe(422);
    const first = await unixJson(socket, "/v1/host-commands/run", { command: "demo.restart", allow: "privileged", invocationId: "inv-apr_once-0001" }, token());
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ exitCode: 0, stdout: "restarted" });
    const again = await unixJson(socket, "/v1/host-commands/run", { command: "demo.restart", allow: "privileged", invocationId: "inv-apr_once-0001" }, token());
    expect(again.status).toBe(409);
    expect(readFileSync(`${socket}.effects`, "utf8").split("\n").filter(Boolean)).toEqual(["inv-apr_once-0001"]);
  });
});

describe("a failed tool call keeps the script's own reason", () => {
  it("adds the error the pinned script printed before exiting non-zero, and falls back to the exit code", () => {
    expect(failedToolMessage(2, JSON.stringify({ error: "that path is outside the readable area" }), [])).toBe("tool exit 2: that path is outside the readable area");
    expect(failedToolMessage(2, "not json", [])).toBe("tool exit 2");
    expect(failedToolMessage(1, JSON.stringify({ error: "token abc123 leaked" }), ["abc123"])).not.toContain("abc123");
  });
});
