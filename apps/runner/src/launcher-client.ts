import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";

/**
 * Client for the constrained launcher's Unix-socket HTTP API (doc 20).
 *
 * The runner supervisor is the only production caller: governed tool
 * execution goes through these sandboxes instead of host bash. The scoped
 * token file is read from the socket directory unless BRAIN_LAUNCHER_TOKEN
 * is set explicitly.
 */
export class LauncherClient {
  private readonly token: string | undefined;

  constructor(private readonly socketPath: string) {
    const tokenFile = process.env["BRAIN_LAUNCHER_TOKEN_FILE"] ?? `${socketPath}.token`;
    try { this.token = process.env["BRAIN_LAUNCHER_TOKEN"] ?? readFileSync(tokenFile, "utf8").trim(); }
    catch { this.token = undefined; }
  }

  private call(method: string, path: string, body?: unknown, timeoutMs = 90_000): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest({
        socketPath: this.socketPath, path, method,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        timeout: timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > 2 * 1024 * 1024) { req.destroy(); reject(new Error("launcher response too large")); return; }
          chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
        });
      });
      req.on("timeout", () => req.destroy(new Error("launcher request timed out")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  static configured(): boolean {
    return Boolean(process.env["BRAIN_LAUNCHER_SOCKET"]);
  }

  static fromEnv(): LauncherClient {
    const socketPath = process.env["BRAIN_LAUNCHER_SOCKET"];
    if (!socketPath) throw new Error("BRAIN_LAUNCHER_SOCKET is not configured");
    return new LauncherClient(socketPath);
  }

  async health(): Promise<{ docker: boolean }> {
    const r = await this.call("GET", "/v1/health", undefined, 10_000);
    if (r.status !== 200) throw new Error(`launcher health failed ${r.status}`);
    return { docker: r.json["docker"] === true };
  }

  async createSandbox(input: { profile: "agent" | "privileged-tool" | "evaluator"; requestId: string; toolsDir?: string; network?: "none" | "internal"; cpuMillicores?: number; memoryMb?: number }): Promise<{ sandboxId: string }> {
    const image = input.profile === "privileged-tool" ? "brain-sandbox-tool" : input.profile === "evaluator" ? "brain-sandbox-evaluator" : "brain-sandbox-agent";
    const r = await this.call("POST", "/v1/sandboxes", {
      profile: input.profile, image, requestId: input.requestId,
      network: input.network ?? "none", toolsDir: input.toolsDir,
      cpuMillicores: input.cpuMillicores ?? 1000, memoryMb: input.memoryMb ?? 1024,
    });
    if (r.status !== 201 && r.status !== 200) throw new Error(`sandbox create failed ${r.status}: ${String(r.json["error"] ?? "")}`);
    return { sandboxId: String(r.json["sandboxId"]) };
  }

  async exec(sandboxId: string, script: string, input: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    const r = await this.call("POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`, { argv: ["/bin/bash"], script, input, timeoutMs });
    if (r.status !== 200) throw new Error(`sandbox exec failed ${r.status}: ${String(r.json["error"] ?? "")}`);
    return { exitCode: Number(r.json["exitCode"]), stdout: String(r.json["stdout"] ?? ""), stderr: String(r.json["stderr"] ?? ""), timedOut: r.json["timedOut"] === true };
  }

  async stop(sandboxId: string): Promise<{ terminationConfirmed: boolean }> {
    const r = await this.call("POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/stop`, { graceMs: 3000 });
    if (r.status !== 200) throw new Error(`sandbox stop failed ${r.status}`);
    return { terminationConfirmed: r.json["terminationConfirmed"] === true };
  }
}
