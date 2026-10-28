import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { startLauncher } from "../../apps/launcher/src/server";

// T21 packet acceptance (validation boundary): the trusted launcher accepts
// only fixed profiles/preinstalled images and an exact field allowlist —
// smuggled docker surface (privileged, mounts, env, argv, caller-named
// networks) is rejected before any docker call. Full create/stop/egress
// behavior is proven in tests/probes/sandbox with a live daemon.
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

describe("launcher validation boundary (T21)", () => {
  it("health advertises only fixed profiles and preinstalled images", async () => {
    const socket = `/tmp/brain-launcher-sec-${Date.now()}/launcher.sock`;
    process.env["BRAIN_LAUNCHER_SOCKET"] = socket;
    await startLauncher();
    const health = await unixJson(socket, "GET", "/v1/health");
    expect(health.status).toBe(200);
    expect(health.json["profiles"]).toEqual(["agent", "privileged-tool", "evaluator"]);
    expect(health.json["images"]).toEqual(["brain-sandbox-agent", "brain-sandbox-tool", "brain-sandbox-evaluator"]);
  }, 60_000);

  it("smuggled fields, unknown profiles and foreign images are 422 before docker", async () => {
    const socket = `/tmp/brain-launcher-sec2-${Date.now()}/launcher.sock`;
    process.env["BRAIN_LAUNCHER_SOCKET"] = socket;
    await startLauncher();
    const base = { profile: "agent", image: "brain-sandbox-agent", requestId: "sec-1" };
    for (const smuggled of [
      { ...base, privileged: true },
      { ...base, mounts: ["/:/host"] },
      { ...base, env: { EVIL: "1" } },
      { ...base, cmd: ["sh", "-c", "id"] },
      { ...base, devices: ["/dev/kvm"] },
      { ...base, capAdd: ["SYS_ADMIN"] },
    ]) {
      const res = await unixJson(socket, "POST", "/v1/sandboxes", smuggled);
      expect(res.status, JSON.stringify(smuggled)).toBe(422);
      expect(String(res.json["error"])).toMatch(/forbidden/);
    }
    expect((await unixJson(socket, "POST", "/v1/sandboxes", { ...base, profile: "root-shell" })).status).toBe(422);
    expect((await unixJson(socket, "POST", "/v1/sandboxes", { ...base, image: "alpine:latest" })).status).toBe(422);
    expect((await unixJson(socket, "POST", "/v1/sandboxes", { ...base, image: "brain-sandbox-agent:pwned" })).status).toBe(422);
    // Unknown sandbox stop is a clean 404, not a docker error leak.
    const stop = await unixJson(socket, "POST", "/v1/sandboxes/nope/stop", { graceMs: 1 });
    expect(stop.status).toBe(404);
  }, 60_000);
});
