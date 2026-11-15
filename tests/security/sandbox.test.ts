import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLauncher } from "../../apps/launcher/src/server";
import { scaled } from "../support/timing";

// T21 packet acceptance (validation boundary): the trusted launcher accepts
// only fixed profiles/preinstalled images and an exact field allowlist —
// smuggled docker surface (privileged, mounts, env, argv, caller-named
// networks) is rejected before any docker call. Full create/stop/egress
// behavior is proven in tests/probes/sandbox with a live daemon.
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

describe("launcher validation boundary (T21)", () => {
  it("health advertises only fixed profiles and preinstalled images", async () => {
    const socket = join(tmpdir(), `brain-launcher-sec-${Date.now()}`, "launcher.sock");
    process.env["BRAIN_LAUNCHER_SOCKET"] = socket;
    await startLauncher();
    const health = await unixJson(socket, "GET", "/v1/health", undefined, readFileSync(`${socket}.token`, "utf8").trim());
    expect(health.status).toBe(200);
    expect(health.json["profiles"]).toEqual(["agent", "privileged-tool", "evaluator"]);
    expect(health.json["images"]).toEqual(["brain-sandbox-agent", "brain-sandbox-tool", "brain-sandbox-evaluator", "brain-sandbox-engine"]);
  }, scaled(60_000));

  it("smuggled fields, unknown profiles and foreign images are 422 before docker", async () => {
    const socket = join(tmpdir(), `brain-launcher-sec2-${Date.now()}`, "launcher.sock");
    process.env["BRAIN_LAUNCHER_SOCKET"] = socket;
    await startLauncher();
    const token = readFileSync(`${socket}.token`, "utf8").trim();
    const base = { profile: "agent", image: "brain-sandbox-agent", requestId: "sec-1" };
    for (const smuggled of [
      { ...base, privileged: true },
      { ...base, mounts: ["/:/host"] },
      { ...base, env: { EVIL: "1" } },
      { ...base, cmd: ["sh", "-c", "id"] },
      { ...base, devices: ["/dev/kvm"] },
      { ...base, capAdd: ["SYS_ADMIN"] },
    ]) {
      const res = await unixJson(socket, "POST", "/v1/sandboxes", smuggled, token);
      expect(res.status, JSON.stringify(smuggled)).toBe(422);
      expect(String(res.json["error"])).toMatch(/forbidden/);
    }
    expect((await unixJson(socket, "POST", "/v1/sandboxes", { ...base, profile: "root-shell" }, token)).status).toBe(422);
    expect((await unixJson(socket, "POST", "/v1/sandboxes", { ...base, image: "alpine:latest" }, token)).status).toBe(422);
    expect((await unixJson(socket, "POST", "/v1/sandboxes", { ...base, image: "brain-sandbox-agent:pwned" }, token)).status).toBe(422);
    // Unknown sandbox stop is a clean 404, not a docker error leak.
    const stop = await unixJson(socket, "POST", "/v1/sandboxes/nope/stop", { graceMs: 1 }, token);
    expect(stop.status).toBe(404);
  }, scaled(60_000));

  it("a network is only the egress proxy's, only for named hosts, and never a privileged tool's (ADR 0037)", async () => {
    const socket = join(tmpdir(), `brain-launcher-sec3-${Date.now()}`, "launcher.sock");
    process.env["BRAIN_LAUNCHER_SOCKET"] = socket;
    delete process.env["BRAIN_LAUNCHER_EGRESS_GRANTS_DIR"];
    await startLauncher();
    const token = readFileSync(`${socket}.token`, "utf8").trim();
    const base = { profile: "agent", image: "brain-sandbox-agent", requestId: "sec-egress" };
    const refused = async (body: Record<string, unknown>, status: number, message: RegExp) => {
      const res = await unixJson(socket, "POST", "/v1/sandboxes", body, token);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(String(res.json["error"])).toMatch(message);
    };
    for (const bad of ["https://example.com", "example.com/path", "*.example.com", "Example.COM", "example.com:", "-bad.example", "a b"]) {
      await refused({ ...base, network: "internal", egressHosts: [bad] }, 422, /egressHosts must be/);
    }
    await refused({ ...base, network: "internal", egressHosts: Array.from({ length: 101 }, (_, i) => `h${i}.example`) }, 422, /egressHosts must be/);
    await refused({ ...base, network: "internal" }, 422, /must name the egressHosts/);
    await refused({ ...base, network: "none", egressHosts: ["example.com"] }, 422, /need network internal/);
    await refused({ ...base, profile: "privileged-tool", image: "brain-sandbox-tool", network: "internal", egressHosts: ["example.com"] }, 422, /never gets a network/);
    // Without an operator-declared grants directory there is no proxy to hold a grant: the launcher refuses rather than open a network.
    await refused({ ...base, network: "internal", egressHosts: ["example.com", "api.example.com:8443"] }, 409, /egress proxy is not configured/);
  }, scaled(60_000));
});
