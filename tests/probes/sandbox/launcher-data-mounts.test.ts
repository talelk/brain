import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLauncher } from "../../../apps/launcher/src/server";

function unixJson(socket: string, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = request({ socketPath: socket, method, path, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
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

const root = join(tmpdir(), `brain-data-mounts-${Date.now()}`);
const declared = join(root, "declared");
const tools = join(root, "tools");
const socket = join(root, "run", "launcher.sock");

describe("G06 operator-declared read-only data mounts", () => {
  beforeAll(async () => {
    mkdirSync(declared, { recursive: true });
    mkdirSync(tools, { recursive: true });
    writeFileSync(join(declared, "fact.csv"), "id\n1\n");
    // Reads the mounted data, then proves the mount cannot be written to.
    writeFileSync(join(tools, "probe.sh"), [
      "#!/usr/bin/env bash",
      "cat /data/cv-data/fact.csv",
      "if touch /data/cv-data/pwned 2>/dev/null; then echo WRITABLE; else echo READ_ONLY; fi",
      "ls /data/cv-data/pwned 2>/dev/null || true",
      "",
    ].join("\n"), { mode: 0o755 });
    process.env["BRAIN_LAUNCHER_SOCKET"] = socket;
    process.env["BRAIN_LAUNCHER_DATA_MOUNTS"] = `cv-data=${declared},absent=${join(root, "never-created")}`;
    await startLauncher();
  }, 60_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("publishes only the operator's mount names and refuses everything else", async () => {
    const token = readFileSync(`${socket}.token`, "utf8").trim();
    const health = await unixJson(socket, "GET", "/v1/health", undefined, token);
    expect(health.json["dataMounts"]).toEqual(["cv-data", "absent"]);

    const base = { profile: "agent", image: "brain-sandbox-agent" };
    // A workflow cannot name a path it was not given.
    const unknown = await unixJson(socket, "POST", "/v1/sandboxes", { ...base, requestId: "dm-1", dataMounts: ["etc"] }, token);
    expect(unknown.status).toBe(422);
    // A host path smuggled through the name field is not a name.
    const smuggled = await unixJson(socket, "POST", "/v1/sandboxes", { ...base, requestId: "dm-2", dataMounts: ["/etc"] }, token);
    expect(smuggled.status).toBe(422);
    // The mount list itself is not a caller-settable channel.
    const raw = await unixJson(socket, "POST", "/v1/sandboxes", { ...base, requestId: "dm-3", mounts: ["/:/host:ro"] }, token);
    expect(raw.status).toBe(422);
    // Declared but not present on this host is a deployment fault, not a pass.
    const missing = await unixJson(socket, "POST", "/v1/sandboxes", { ...base, requestId: "dm-4", dataMounts: ["absent"] }, token);
    expect(missing.status).toBe(409);
  }, 120_000);

  it("mounts a declared path read-only and never grants write access", async () => {
    const token = readFileSync(`${socket}.token`, "utf8").trim();
    const created = await unixJson(socket, "POST", "/v1/sandboxes", { profile: "agent", image: "brain-sandbox-agent", requestId: "dm-ro", toolsDir: tools, dataMounts: ["cv-data"] }, token);
    expect(created.status).toBe(201);
    const sandboxId = String(created.json["sandboxId"]);
    try {
      const probe = await unixJson(socket, "POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`, { script: "/tools/probe.sh", timeoutMs: 20_000 }, token);
      expect(probe.json["exitCode"]).toBe(0);
      const out = String(probe.json["stdout"]);
      expect(out).toContain("id\n1");
      expect(out).toContain("READ_ONLY");
      expect(out).not.toContain("WRITABLE");
    } finally {
      const stopped = await unixJson(socket, "POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/stop`, { graceMs: 2000 }, token);
      expect(stopped.json["cleanupConfirmed"]).toBe(true);
    }
  }, 180_000);
});
