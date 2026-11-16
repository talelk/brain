import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { EngineChannel, EngineSandboxRequest } from "./engines/sandboxed";

export interface CommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }

/** One run of a tool's `run.sh` in a tool sandbox. The launcher finds the tool's files and the working copy under the attempt's directory. */
export interface ToolRun {
  readonly attemptId: string;
  readonly tool: string;
  /** Names the container; one per call. */
  readonly requestId: string;
  /** The tool's `network` hosts: what its sandbox reaches through the egress proxy. None means no network. */
  readonly egressHosts: readonly string[];
  /** The validated input, as JSON, on the script's standard input. */
  readonly input: string;
  readonly timeoutMs: number;
  /** The tool's leased secrets, as environment variables of this one run. */
  readonly secretEnv: Readonly<Record<string, string>>;
}

/** What the runner asks of the trusted launcher. Tests hand in their own. */
export interface Launcher {
  health(): Promise<{ docker: boolean; missingImages: string[] }>;
  runTool(run: ToolRun): Promise<CommandResult>;
  /** Runs one operator-declared host command by name; the launcher alone decides the argv. */
  hostCommand(command: string, args: Readonly<Record<string, string>>, allow: "read" | "privileged", invocationId: string): Promise<CommandResult>;
  /** Starts an engine's own container for one attempt and returns the channel to the engine host in it. */
  openEngine(request: EngineSandboxRequest): Promise<EngineChannel>;
}

/**
 * Client for the launcher's Unix-socket HTTP API. The scoped token is read from the file beside the socket unless
 * BRAIN_LAUNCHER_TOKEN is set.
 */
export class LauncherClient implements Launcher {
  private readonly token: string | undefined;

  constructor(private readonly socketPath: string, env: NodeJS.ProcessEnv = process.env) {
    try { this.token = env["BRAIN_LAUNCHER_TOKEN"] ?? readFileSync(env["BRAIN_LAUNCHER_TOKEN_FILE"] ?? `${socketPath}.token`, "utf8").trim(); }
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
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > 4 * 1024 * 1024) { req.destroy(); reject(new Error("launcher response too large")); return; }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try { resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} }); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
        });
      });
      req.on("timeout", () => req.destroy(new Error("launcher request timed out")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private static result(json: Record<string, unknown>): CommandResult {
    return { exitCode: Number(json["exitCode"]), stdout: String(json["stdout"] ?? ""), stderr: String(json["stderr"] ?? ""), timedOut: json["timedOut"] === true };
  }

  async health(): Promise<{ docker: boolean; missingImages: string[] }> {
    const answer = await this.call("GET", "/v1/health", undefined, 10_000);
    if (answer.status !== 200) throw new Error(`launcher health failed ${answer.status}`);
    return { docker: answer.json["docker"] === true, missingImages: Array.isArray(answer.json["missingImages"]) ? answer.json["missingImages"].map(String) : [] };
  }

  async runTool(run: ToolRun): Promise<CommandResult> {
    const answer = await this.call("POST", "/v1/tool-runs", run, run.timeoutMs + 60_000);
    if (answer.status !== 200) throw new Error(`the tool sandbox could not run (${answer.status}): ${String(answer.json["error"] ?? "")}`);
    return LauncherClient.result(answer.json);
  }

  async hostCommand(command: string, args: Readonly<Record<string, string>>, allow: "read" | "privileged", invocationId: string): Promise<CommandResult> {
    // The operator's own timeout of a command is at most ten minutes; the answer is waited for a little longer than that.
    const answer = await this.call("POST", "/v1/host-commands/run", { command, args, allow, invocationId }, 630_000);
    if (answer.status !== 200) throw new Error(String(answer.json["error"] ?? `host command refused (${answer.status})`));
    return LauncherClient.result(answer.json);
  }

  async openEngine(request: EngineSandboxRequest): Promise<EngineChannel> {
    const created = await this.call("POST", "/v1/engine-sandboxes", request, 120_000);
    if (created.status !== 201 && created.status !== 200) throw new Error(`engine sandbox create failed ${created.status}: ${String(created.json["error"] ?? "")}`);
    const id = encodeURIComponent(String(created.json["sandboxId"]));
    let ended = false;
    return {
      send: async (line) => {
        const sent = await this.call("POST", `/v1/engine-sandboxes/${id}/input`, { lines: [line] }, 30_000);
        if (sent.status !== 200) throw new Error(`engine sandbox input failed ${sent.status}: ${String(sent.json["error"] ?? "")}`);
      },
      lines: () => {
        const call = this.call.bind(this);
        return (async function* (): AsyncGenerator<string> {
          let after = 0;
          while (!ended) {
            const polled = await call("GET", `/v1/engine-sandboxes/${id}/output?after=${after}&waitMs=20000`, undefined, 45_000);
            if (polled.status !== 200) throw new Error(`engine sandbox output failed ${polled.status}: ${String(polled.json["error"] ?? "")}`);
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
      },
    };
  }
}
