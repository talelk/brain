import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import type { EngineChannel, EngineSandboxOpener, EngineSandboxRequest } from "./engines/sandboxed";

/**
 * Client for the constrained launcher's Unix-socket HTTP API (doc 20).
 *
 * The runner supervisor is the only production caller: governed tool
 * execution goes through these sandboxes instead of host bash. The scoped
 * token file is read from the socket directory unless BRAIN_LAUNCHER_TOKEN
 * is set explicitly.
 */
export class LauncherClient implements EngineSandboxOpener {
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

  async health(): Promise<{ docker: boolean; missingImages: string[] }> {
    const r = await this.call("GET", "/v1/health", undefined, 10_000);
    if (r.status !== 200) throw new Error(`launcher health failed ${r.status}`);
    return { docker: r.json["docker"] === true, missingImages: Array.isArray(r.json["missingImages"]) ? r.json["missingImages"].map(String) : [] };
  }

  async createSandbox(input: { profile: "agent" | "privileged-tool" | "evaluator"; requestId: string; toolsDir?: string; network?: "none" | "internal"; egressHosts?: readonly string[]; cpuMillicores?: number; memoryMb?: number; dataMounts?: readonly string[] }): Promise<{ sandboxId: string }> {
    const image = input.profile === "privileged-tool" ? "brain-sandbox-tool" : input.profile === "evaluator" ? "brain-sandbox-evaluator" : "brain-sandbox-agent";
    const r = await this.call("POST", "/v1/sandboxes", {
      profile: input.profile, image, requestId: input.requestId,
      network: input.network ?? "none", toolsDir: input.toolsDir,
      ...(input.egressHosts && input.egressHosts.length > 0 ? { egressHosts: [...input.egressHosts] } : {}),
      cpuMillicores: input.cpuMillicores ?? 1000, memoryMb: input.memoryMb ?? 1024,
      ...(input.dataMounts && input.dataMounts.length > 0 ? { dataMounts: [...input.dataMounts] } : {}),
    });
    if (r.status !== 201 && r.status !== 200) throw new Error(`sandbox create failed ${r.status}: ${String(r.json["error"] ?? "")}`);
    return { sandboxId: String(r.json["sandboxId"]) };
  }

  async exec(sandboxId: string, script: string, input: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    const r = await this.call("POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`, { argv: ["/bin/bash"], script, input, timeoutMs });
    if (r.status !== 200) throw new Error(`sandbox exec failed ${r.status}: ${String(r.json["error"] ?? "")}`);
    return { exitCode: Number(r.json["exitCode"]), stdout: String(r.json["stdout"] ?? ""), stderr: String(r.json["stderr"] ?? ""), timedOut: r.json["timedOut"] === true };
  }

  /** Runs one operator-declared host command by name (ADR 0021); the launcher alone decides the argv. */
  async hostCommand(command: string, args: Record<string, string>, allow: "read" | "privileged", invocationId?: string): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    const r = await this.call("POST", "/v1/host-commands/run", { command, args, allow, ...(invocationId ? { invocationId } : {}) }, 90_000);
    if (r.status !== 200) throw new Error(String(r.json["error"] ?? `host command refused (${r.status})`));
    return { exitCode: Number(r.json["exitCode"]), stdout: String(r.json["stdout"] ?? ""), stderr: String(r.json["stderr"] ?? ""), timedOut: r.json["timedOut"] === true };
  }

  /**
   * Starts an engine's own container for one attempt (ADR 0067) and returns the channel to the engine host in it. The launcher alone decides
   * the image, the argv, the mount and the network's form; this names the engine, the attempt, the reservation and the hosts. A container
   * that does not come up rejects with the launcher's reason, and nothing else runs the engine.
   */
  async open(request: EngineSandboxRequest): Promise<EngineChannel> {
    const created = await this.call("POST", "/v1/engine-sandboxes", {
      engine: request.engine, attemptId: request.attemptId, requestId: request.requestId,
      cpuMillicores: request.cpuMillicores, memoryMb: request.memoryMb, egressHosts: [...request.egressHosts],
    }, 120_000);
    if (created.status !== 201 && created.status !== 200) throw new Error(`engine sandbox create failed ${created.status}: ${String(created.json["error"] ?? "")}`);
    const id = encodeURIComponent(String(created.json["sandboxId"]));
    let ended = false;
    return {
      send: async (line) => {
        const sent = await this.call("POST", `/v1/engine-sandboxes/${id}/input`, { lines: [line] }, 30_000);
        if (sent.status !== 200) throw new Error(`engine sandbox exec failed ${sent.status} (input): ${String(sent.json["error"] ?? "")}`);
      },
      lines: () => {
        const call = this.call.bind(this);
        return (async function* (): AsyncGenerator<string> {
          let after = 0;
          while (!ended) {
            const polled = await call("GET", `/v1/engine-sandboxes/${id}/output?after=${after}&waitMs=20000`, undefined, 45_000);
            if (polled.status !== 200) throw new Error(`engine sandbox exec failed ${polled.status} (output): ${String(polled.json["error"] ?? "")}`);
            const lines = Array.isArray(polled.json["lines"]) ? polled.json["lines"].map(String) : [];
            after = Number(polled.json["next"] ?? after + lines.length);
            yield* lines;
            if (polled.json["closed"] === true) return;
          }
        })();
      },
      close: async () => {
        ended = true;
        const stopped = await this.call("POST", `/v1/engine-sandboxes/${id}/stop`, { graceMs: 3000 }, 60_000);
        if (stopped.status !== 200) throw new Error(`engine sandbox stop failed ${stopped.status}`);
        return { terminationConfirmed: stopped.json["terminationConfirmed"] === true };
      },
    };
  }

  async stop(sandboxId: string): Promise<{ terminationConfirmed: boolean }> {
    const r = await this.call("POST", `/v1/sandboxes/${encodeURIComponent(sandboxId)}/stop`, { graceMs: 3000 });
    if (r.status !== 200) throw new Error(`sandbox stop failed ${r.status}`);
    return { terminationConfirmed: r.json["terminationConfirmed"] === true };
  }
}
