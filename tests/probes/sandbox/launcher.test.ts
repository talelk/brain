import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { startLauncher } from "../../../apps/launcher/src/server";

function unixJson(socket: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = request({ socketPath: socket, method, path, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

describe("G06 launcher sandbox (requires docker + brain-sandbox-* tags of alpine)", () => {
  it("creates a fixed-profile sandbox, rejects smuggled fields, stops with cleanup", async () => {
    const socket = `/tmp/brain-launcher-test-${Date.now()}/launcher.sock`;
    process.env["BRAIN_LAUNCHER_SOCKET"] = socket;
    await startLauncher();
    const health = await unixJson(socket, "GET", "/v1/health");
    expect(health.json["docker"]).toBe(true);
    const bad = await unixJson(socket, "POST", "/v1/sandboxes", { profile: "agent", image: "brain-sandbox-agent", requestId: "bad-1", privileged: true });
    expect(bad.status).toBe(422);
    const created = await unixJson(socket, "POST", "/v1/sandboxes", { profile: "agent", image: "brain-sandbox-agent", requestId: "sb-1", network: "none" });
    expect(created.status).toBe(201);
    const sandboxId = String(created.json["sandboxId"]);
    const replay = await unixJson(socket, "POST", "/v1/sandboxes", { profile: "agent", image: "brain-sandbox-agent", requestId: "sb-1", network: "none" });
    expect(String(replay.json["sandboxId"])).toBe(sandboxId);
    const stopped = await unixJson(socket, "POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/stop`, { graceMs: 2000 });
    expect(stopped.json["cleanupConfirmed"]).toBe(true);
  }, 120_000);

  it("TERM-ignoring daemonized child is killed with the sandbox (E065)", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const execa = async (file: string, args: string[], opts?: { timeout?: number; reject?: boolean }) => {
      try {
        const { stdout, stderr } = await run(file, args, { timeout: opts?.timeout ?? 15_000 });
        return { exitCode: 0, stdout, stderr };
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string };
        if (opts?.reject === false) return { exitCode: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
        throw e;
      }
    };
    const socket = `/tmp/brain-launcher-test-${Date.now()}-e065/launcher.sock`;
    process.env["BRAIN_LAUNCHER_SOCKET"] = socket;
    await startLauncher();
    const created = await unixJson(socket, "POST", "/v1/sandboxes", { profile: "agent", image: "brain-sandbox-agent", requestId: "sb-e065", network: "none" });
    expect(created.status).toBe(201);
    const sandboxId = String(created.json["sandboxId"]);
    const containerId = String(created.json["containerId"]);
    // Daemonize: detached, TERM trapped, double-forked sleeper inside the sandbox.
    await execa("docker", ["exec", "-d", containerId, "sh", "-c", "trap '' TERM; (sleep 600 &) ; sleep 600"], { timeout: 15_000 });
    const before = await execa("docker", ["top", containerId], { timeout: 15_000 });
    expect(String(before.stdout)).toContain("sleep");
    const stopped = await unixJson(socket, "POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/stop`, { graceMs: 1000 });
    expect(stopped.json["terminationConfirmed"]).toBe(true);
    expect(stopped.json["cleanupConfirmed"]).toBe(true);
    const gone = await execa("docker", ["inspect", containerId], { timeout: 10_000, reject: false });
    expect(gone.exitCode).not.toBe(0); // pid namespace destroyed: daemon cannot survive it
  }, 120_000);
});
