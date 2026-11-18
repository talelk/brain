import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { EngineAdapter } from "./port";
import { decodeFrame, encodeFrame, type ExecResult, type HostFrame, type HostRequest } from "./sandbox-protocol";
import { createEngine } from "./select";

/** How much of a setup command's output is kept: its end, where a failure says why. */
const EXEC_OUTPUT_CHARS = 8000;

/**
 * Runs one shell command in the sandbox (a project's setup) and reports how it ended. The command is its own process group, and a
 * timeout or an abort kills the whole group: a grandchild that holds the output pipe would otherwise keep the command "running".
 */
function exec(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killGroup = (): void => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    if (signal.aborted) killGroup();
    let output = "";
    let timedOut = false;
    const keep = (chunk: Buffer): void => { output = (output + chunk.toString("utf8")).slice(-EXEC_OUTPUT_CHARS); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    signal.addEventListener("abort", killGroup, { once: true });
    child.on("error", (error) => { clearTimeout(timer); resolve({ exitCode: 127, output: error.message, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, output, timedOut }); });
  });
}

/**
 * The process that runs inside an engine sandbox: it serves the engine port over `input`/`write` for the one engine the runner's `init`
 * frame names. It holds no authority of its own: workspace-tool calls leave through the event stream and come back as the text the runner
 * decided. When its input ends (the runner or the launcher is gone) it cancels the engine and stops, so a sandbox never outlives its owner.
 */
export function serveEngineHost(input: Readable, write: (text: string) => void, select: (engine: string) => EngineAdapter | undefined = createEngine): Promise<void> {
  let engine: EngineAdapter | undefined;
  const running = new Map<number, AbortController>();
  const send = (frame: HostFrame): void => write(encodeFrame(frame));

  async function handle(request: HostRequest): Promise<void> {
    const controller = new AbortController();
    running.set(request.id, controller);
    const done = (result: Extract<HostFrame, { type: "result" }>["result"] = {}): void => send({ type: "result", id: request.id, result });
    try {
      if (request.op === "abort") { running.get(request.target)?.abort(); done(); return; }
      if (request.op === "exec") { done(await exec(request.command, request.cwd, request.timeoutMs, controller.signal)); return; }
      if (request.op === "init") {
        if (engine) throw new Error("the engine host is already initialised");
        engine = select(request.engine);
        if (!engine) throw new Error(`engine ${request.engine} is not available in this sandbox`);
        done();
        return;
      }
      if (!engine) throw new Error("the engine host has not been initialised");
      switch (request.op) {
        case "probe": done(await engine.probe()); return;
        case "start": await engine.start(request.spec, controller.signal); done(); return;
        case "events":
          for await (const event of engine.events(controller.signal)) send({ type: "event", id: request.id, event });
          send({ type: "end", id: request.id });
          return;
        case "toolResult": await engine.toolResult(request.callId, request.text); done(); return;
        case "cancel": await engine.cancel(); done(); return;
        case "dispose": await engine.dispose(); done(); return;
      }
    } catch (error) {
      send({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      // A session outlives the `start` request that began it: its abort signal stays until the session is cancelled.
      if (request.op !== "start") running.delete(request.id);
    }
  }

  send({ type: "ready" });
  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const request = decodeFrame<HostRequest>(line);
      if (request) void handle(request);
    });
    lines.on("close", () => {
      void (async () => {
        for (const controller of running.values()) controller.abort();
        await engine?.cancel().catch(() => undefined);
        resolve();
      })();
    });
  });
}

// The container's entry point: stdout carries frames only, so an engine library that logs is moved to stderr first.
if (process.env["BRAIN_ENGINE_HOST"] === "1") {
  const frames = process.stdout.write.bind(process.stdout);
  console.log = console.error;
  console.info = console.error;
  await serveEngineHost(process.stdin, (text) => { frames(text); });
  process.exit(0);
}
