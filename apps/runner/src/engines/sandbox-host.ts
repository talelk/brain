import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { EngineAdapter } from "@brain/contracts";
import { decodeFrame, encodeFrame, type HostFrame, type HostInit, type HostRequest } from "./sandbox-protocol";
import { selectEngine } from "./run";

export interface EngineHostOptions {
  /** Builds the engine for an init frame; the real one is `selectEngine`. */
  readonly select?: (init: HostInit) => EngineAdapter | undefined;
  /** Puts the init frame's settings and credentials where the engine reads them (the process environment). */
  readonly applyEnvironment?: (env: Readonly<Record<string, string>>, secrets: Readonly<Record<string, string>>) => void;
  /** Called once the runner has gone (its end of the pipe closed) and the engine is cancelled. */
  readonly onClose?: () => void;
}

const defaultSelect = (init: HostInit): EngineAdapter | undefined => selectEngine(init.engine, init.toolBindings, init.route);
const defaultApply = (env: Readonly<Record<string, string>>, secrets: Readonly<Record<string, string>>): void => { Object.assign(process.env, env, secrets); };

/**
 * The process that runs inside an engine sandbox: it serves the engine adapter port over `input`/`write` for one engine, built on the
 * runner's `init` frame. It holds no authority of its own: tool proposals leave through the event stream and come back as results the
 * runner decided. When its input ends (the runner or the launcher is gone) it cancels the engine and stops, so a sandbox never outlives
 * its owner.
 */
export function serveEngineHost(input: Readable, write: (text: string) => void, options: EngineHostOptions = {}): Promise<void> {
  const select = options.select ?? defaultSelect;
  const apply = options.applyEnvironment ?? defaultApply;
  let engine: EngineAdapter | undefined;
  const running = new Map<number, AbortController>();
  const sessions = new Set<string>();
  const send = (frame: HostFrame): void => write(encodeFrame(frame));

  async function handle(request: HostRequest): Promise<void> {
    const controller = new AbortController();
    running.set(request.id, controller);
    try {
      if (request.op === "abort") { running.get(request.target)?.abort(); send({ type: "result", id: request.id, result: {} }); return; }
      if (request.op === "init") {
        if (engine) throw new Error("the engine host is already initialised");
        apply(request.init.env, request.init.secrets);
        engine = select(request.init);
        if (!engine) throw new Error(`engine ${request.init.engine} is not available in this sandbox`);
        send({ type: "result", id: request.id, result: {} });
        return;
      }
      if (!engine) throw new Error("the engine host has not been initialised");
      const adapter = engine;
      switch (request.op) {
        case "probe": send({ type: "result", id: request.id, result: await adapter.probe() }); return;
        case "start": {
          const started = await adapter.start(request.spec, controller.signal);
          sessions.add(started.sessionId);
          send({ type: "result", id: request.id, result: started });
          return;
        }
        case "events":
          for await (const event of adapter.events(request.sessionId, request.afterSequence, controller.signal)) send({ type: "event", id: request.id, event });
          send({ type: "end", id: request.id });
          return;
        case "toolResult":
          if (!adapter.toolResult) throw Object.assign(new Error(`${adapter.id} takes no tool results`), { code: "UNSUPPORTED_CAPABILITY" });
          await adapter.toolResult(request.sessionId, request.result);
          send({ type: "result", id: request.id, result: {} });
          return;
        case "cancel": send({ type: "result", id: request.id, result: await adapter.cancel(request.sessionId, request.reason) }); return;
        case "checkpoint": send({ type: "result", id: request.id, result: await adapter.checkpoint(request.sessionId) }); return;
        case "steer":
          if (!adapter.steer) throw Object.assign(new Error(`${adapter.id} does not support steering`), { code: "UNSUPPORTED_CAPABILITY" });
          await adapter.steer(request.sessionId, request.messageId, request.message);
          send({ type: "result", id: request.id, result: {} });
          return;
        case "pause":
          if (!adapter.pause) throw Object.assign(new Error(`${adapter.id} cannot stop at a turn boundary`), { code: "UNSUPPORTED_CAPABILITY" });
          await adapter.pause(request.sessionId);
          send({ type: "result", id: request.id, result: {} });
          return;
        case "continue":
          await adapter.continue?.(request.sessionId);
          send({ type: "result", id: request.id, result: {} });
          return;
        case "dispose":
          await adapter.dispose(request.sessionId);
          sessions.delete(request.sessionId);
          send({ type: "result", id: request.id, result: {} });
          return;
      }
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      send({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error), ...(typeof code === "string" ? { code } : {}) });
    } finally {
      running.delete(request.id);
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
        for (const sessionId of sessions) await engine?.cancel(sessionId, "the runner closed the sandbox").catch(() => undefined);
        options.onClose?.();
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
