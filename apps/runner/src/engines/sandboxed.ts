import type { EngineAdapter, EngineEvent, EngineProbe, EngineSessionSpec } from "./port";
import { decodeFrame, encodeFrame, type ExecResult, type HostFrame, type HostRequest } from "./sandbox-protocol";

/** What the runner asks the launcher for: one engine process, in its own container, for one attempt. */
export interface EngineSandboxRequest {
  readonly engine: string;
  /** Names the attempt's directory on the host: the launcher mounts its `work`, `out` and `state` folders. */
  readonly attemptId: string;
  /** Names this container (and makes a repeated request the same container). */
  readonly requestId: string;
  readonly cpuMillicores: number;
  readonly memoryMb: number;
  /** How the working copy is mounted at `/work`: not at all, read-only, or read-write. */
  readonly work: "none" | "ro" | "rw";
  /** The model gateway's host and the projects' hosts: the whole network the container gets, through the egress proxy. */
  readonly egressHosts: readonly string[];
}

/** The lines the container's engine host wrote, and the means to write to it and to end it. */
export interface EngineChannel {
  send(line: string): Promise<void>;
  /** Lines from the container; ends when the container is gone. */
  lines(): AsyncIterable<string>;
  close(): Promise<void>;
}

/** The paths of an attempt's folders as an engine in a sandbox sees them. */
export const SANDBOX_PATHS = { work: "/work", out: "/out", state: "/state" } as const;

export const SANDBOX_REFUSAL = "engine sandbox create failed";

type WithoutId<R> = R extends unknown ? Omit<R, "id"> : never;
interface Pending { readonly resolve: (frame: HostFrame) => void; readonly reject: (error: Error) => void }

/** The frames of one streaming request, handed over as they arrive. */
class FrameQueue {
  private readonly items: HostFrame[] = [];
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  push(frame: HostFrame): void { this.items.push(frame); this.wake?.(); }
  fail(error: Error): void { this.failure = error; this.wake?.(); }
  async next(): Promise<HostFrame> {
    for (;;) {
      const frame = this.items.shift();
      if (frame) return frame;
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

/**
 * An engine adapter whose engine runs in its attempt's sandbox: every call goes over the sandbox's channel to the engine host in the
 * container. The sandbox starts with the first call and lives until `close()`, so a project's setup command, the session and its
 * corrective session share it. If the sandbox cannot start the call fails with SANDBOX_REFUSAL; there is no in-process engine behind
 * this class to fall back to.
 */
export class SandboxedEngine implements EngineAdapter {
  readonly id: string;
  private channel: EngineChannel | undefined;
  private opening: Promise<void> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly streams = new Map<number, FrameQueue>();
  private lost: Error | undefined;

  constructor(private readonly open: () => Promise<EngineChannel>, engineId: string) { this.id = engineId; }

  private ready(): Promise<void> {
    this.opening ??= (async () => {
      let channel: EngineChannel | undefined;
      try {
        channel = await this.open();
        this.channel = channel;
        void this.pump(channel);
        await this.call({ op: "init", engine: this.id });
      } catch (error) {
        this.channel = undefined;
        if (channel) await channel.close().catch(() => undefined);
        throw error instanceof Error && error.message.startsWith(SANDBOX_REFUSAL) ? error : new Error(`${SANDBOX_REFUSAL}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    // A sandbox that failed to start stays failed for this attempt: asking again would not change the answer, and nothing else runs the engine.
    return this.opening;
  }

  private async pump(channel: EngineChannel): Promise<void> {
    try {
      for await (const line of channel.lines()) {
        const frame = decodeFrame<HostFrame>(line);
        if (!frame || frame.type === "ready") continue;
        const stream = this.streams.get(frame.id);
        if (stream) { stream.push(frame); continue; }
        const waiting = this.pending.get(frame.id);
        if (waiting) { this.pending.delete(frame.id); waiting.resolve(frame); }
      }
      this.fail(new Error("the engine sandbox ended before the attempt finished"));
    } catch (error) {
      this.fail(new Error(`the engine sandbox was lost: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private fail(error: Error): void {
    this.lost = error;
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    for (const stream of this.streams.values()) stream.fail(error);
  }

  private async write(request: HostRequest): Promise<void> {
    if (this.lost) throw this.lost;
    if (!this.channel) throw new Error(SANDBOX_REFUSAL);
    await this.channel.send(encodeFrame(request));
  }

  /** One request and its one answer. */
  private async call(request: WithoutId<HostRequest>, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const answer = new Promise<HostFrame>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    // The pump may end while the request is being written; the rejection is then met below or ignored here, never left unhandled.
    answer.catch(() => undefined);
    try { await this.write({ ...request, id } as HostRequest); } catch (error) { this.pending.delete(id); throw error; }
    // An aborted request is told to the engine host, which stops what it started for it; its answer still comes.
    const abort = (): void => { void this.write({ id: this.nextId++, op: "abort", target: id }).catch(() => undefined); };
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    let frame: HostFrame;
    try { frame = await answer; } finally { signal?.removeEventListener("abort", abort); }
    if (frame.type === "error") throw new Error(frame.message);
    return frame.type === "result" ? frame.result : undefined;
  }

  async probe(): Promise<EngineProbe> { await this.ready(); return await this.call({ op: "probe" }) as EngineProbe; }

  /** Runs a shell command in the sandbox, before the session: a project's setup. */
  async exec(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> { await this.ready(); return await this.call({ op: "exec", command, cwd, timeoutMs }, signal) as ExecResult; }

  async start(spec: EngineSessionSpec, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("aborted");
    await this.ready();
    await this.call({ op: "start", spec });
    signal.addEventListener("abort", () => { void this.cancel().catch(() => undefined); }, { once: true });
  }

  async *events(signal: AbortSignal): AsyncIterable<EngineEvent> {
    await this.ready();
    const id = this.nextId++;
    const queue = new FrameQueue();
    this.streams.set(id, queue);
    const stop = (): void => { void this.write({ id: this.nextId++, op: "abort", target: id }).catch(() => undefined); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      await this.write({ id, op: "events" });
      for (;;) {
        const frame = await queue.next();
        if (frame.type === "event") yield frame.event;
        else if (frame.type === "end") return;
        else if (frame.type === "error") throw new Error(frame.message);
      }
    } finally {
      signal.removeEventListener("abort", stop);
      this.streams.delete(id);
    }
  }

  async toolResult(callId: string, text: string): Promise<void> { await this.call({ op: "toolResult", callId, text }); }
  async cancel(): Promise<void> { if (this.channel && !this.lost) await this.call({ op: "cancel" }); }
  async dispose(): Promise<void> { if (this.channel && !this.lost) await this.call({ op: "dispose" }); }

  /** Ends the attempt's sandbox; the runner calls it when the attempt is over, whatever way it ended. */
  async close(): Promise<void> {
    await this.opening?.catch(() => undefined);
    const channel = this.channel;
    this.channel = undefined;
    await channel?.close().catch(() => undefined);
  }
}

/** The launcher image for engine sandboxes (the launcher names the same one; the two are separate executables and share no code). */
export const ENGINE_SANDBOX_IMAGE = "brain-sandbox-engine";
