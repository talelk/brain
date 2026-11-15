import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef, Checkpoint, EngineAdapter, EngineEvent, EngineInfo, EngineSessionSpec, EngineToolExecutionResult } from "@brain/contracts";
import { decodeFrame, encodeFrame, type HostFrame, type HostInit, type HostRequest } from "./sandbox-protocol";

/** What the runner asks the launcher for: one engine process, in its own container, for one attempt. */
export interface EngineSandboxRequest {
  readonly engine: string;
  readonly attemptId: string;
  /** Names this container (and makes a repeated request the same container); one per attempt and route. */
  readonly requestId: string;
  readonly cpuMillicores: number;
  readonly memoryMb: number;
  /** The workspace's allowed hosts plus the model host(s) of this attempt: the whole network the container gets, through the egress proxy. */
  readonly egressHosts: readonly string[];
}

/** The lines the container's engine host wrote, and the means to write to it and to end it. */
export interface EngineChannel {
  send(line: string): Promise<void>;
  /** Lines from the container; ends when the container is gone. Lines that are not frames are the engine's own noise and are skipped here. */
  lines(): AsyncIterable<string>;
  /** Stops the container; resolves to whether it is confirmed gone. */
  close(): Promise<{ terminationConfirmed: boolean }>;
}

/** What starts an engine sandbox; the trusted launcher's client in production. A failure to start rejects: nothing runs in its place. */
export interface EngineSandboxOpener {
  open(request: EngineSandboxRequest): Promise<EngineChannel>;
}

export const SANDBOX_REFUSAL = "engine sandbox create failed";

/** Where the attempt's engine state lives on the runner: the one directory its container may write (the launcher mounts the same one). */
export function attemptStateDir(root: string, attemptId: string): string { return join(root, attemptId); }

const CHECKPOINTS = join(".pi-agent", "checkpoints");

/**
 * Makes the attempt's state directory, and places the saved conversation this attempt resumes (found by its digest in an earlier attempt's
 * directory on this runner) where the engine looks for it. An engine keeps its saved conversation on the runner that took it, so a runner
 * that holds none leaves the engine to refuse the resume, exactly as in-process.
 */
export function prepareAttemptState(root: string, attemptId: string, resumeFrom?: ArtifactRef): string {
  const dir = attemptStateDir(root, attemptId);
  mkdirSync(dir, { recursive: true, mode: 0o770 });
  if (resumeFrom) {
    const file = `${resumeFrom.digest.replace(/^sha256:/u, "")}.jsonl`;
    const held = readdirSync(root).map((name) => join(root, name, CHECKPOINTS, file)).find((path) => existsSync(path));
    if (held) {
      mkdirSync(join(dir, CHECKPOINTS), { recursive: true, mode: 0o770 });
      copyFileSync(held, join(dir, CHECKPOINTS, file));
    }
  }
  return dir;
}

/** Keeps this many attempts' saved conversations; older ones are the ones a person is least likely to resume. */
const KEEP_CHECKPOINTED = 20;

/** An attempt's directory goes with the attempt unless it holds a saved conversation; those are kept, newest first, up to a bound. */
export function finishAttemptState(root: string, attemptId: string): void {
  const dir = attemptStateDir(root, attemptId);
  const holdsCheckpoint = (path: string): boolean => existsSync(join(path, CHECKPOINTS)) && readdirSync(join(path, CHECKPOINTS)).length > 0;
  if (existsSync(dir) && !holdsCheckpoint(dir)) rmSync(dir, { recursive: true, force: true });
  const kept = readdirSync(root).map((name) => join(root, name)).filter((path) => statSync(path).isDirectory() && holdsCheckpoint(path))
    .map((path) => ({ path, at: statSync(path).mtimeMs })).sort((a, b) => b.at - a.at);
  for (const old of kept.slice(KEEP_CHECKPOINTED)) rmSync(old.path, { recursive: true, force: true });
}

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

export interface SandboxedEngineOptions {
  readonly engineId: string;
  readonly defaultModelId?: string | undefined;
  /** Undefined when this runner has no launcher: starting then fails, it never runs the engine in the runner. */
  readonly opener: EngineSandboxOpener | undefined;
  readonly attemptId: string;
  readonly requestId: string;
  readonly cpuMillicores: number;
  readonly memoryMb: number;
  readonly egressHosts: readonly string[];
  readonly init: () => HostInit;
  /** The runner's directory of per-attempt engine state. */
  readonly stateRoot: string;
}

/**
 * An engine adapter whose engine runs in its attempt's sandbox (ADR 0073): every call goes over the sandbox's channel to the engine host in
 * the container. The sandbox starts with the first session and lives until `close()`, so the correction session of one attempt shares it. If
 * the sandbox cannot start the call fails with SANDBOX_REFUSAL; there is no in-process engine behind this class to fall back to.
 */
export class SandboxedEngine implements EngineAdapter {
  readonly id: string;
  readonly defaultModelId?: string;
  private channel: EngineChannel | undefined;
  private opening: Promise<EngineChannel> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly streams = new Map<number, FrameQueue>();
  private lost: Error | undefined;

  constructor(private readonly options: SandboxedEngineOptions) {
    this.id = options.engineId;
    if (options.defaultModelId) this.defaultModelId = options.defaultModelId;
  }

  /** What the engine is and offers, asked of the engine in its sandbox: its model must be reachable from there, through the proxy. */
  async probe(): Promise<EngineInfo> { await this.open(undefined); return await this.call({ op: "probe" }) as EngineInfo; }

  private async open(resumeFrom: ArtifactRef | undefined): Promise<EngineChannel> {
    this.opening ??= (async () => {
      const { opener } = this.options;
      if (!opener) throw new Error(`${SANDBOX_REFUSAL}: this runner has no launcher, and ${this.id} does not run in the runner itself`);
      let channel: EngineChannel | undefined;
      try {
        prepareAttemptState(this.options.stateRoot, this.options.attemptId, resumeFrom);
        channel = await opener.open({
          engine: this.id, attemptId: this.options.attemptId, requestId: this.options.requestId,
          cpuMillicores: this.options.cpuMillicores, memoryMb: this.options.memoryMb, egressHosts: this.options.egressHosts,
        });
        this.channel = channel;
        void this.pump(channel);
        await this.call({ op: "init", init: this.options.init() });
        return channel;
      } catch (error) {
        this.channel = undefined;
        if (channel) await channel.close().catch(() => undefined);
        throw error instanceof Error && error.message.startsWith(SANDBOX_REFUSAL) ? error : new Error(`${SANDBOX_REFUSAL}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    // A sandbox that failed to start stays failed for this attempt's engine: asking again would not change the answer, and nothing else runs the engine.
    return await this.opening;
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
      this.fail(new Error("engine sandbox exec failed: the container ended before the step finished"));
    } catch (error) {
      this.fail(new Error(`engine sandbox exec failed: ${error instanceof Error ? error.message : String(error)}`));
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
    await this.channel!.send(encodeFrame(request));
  }

  /** One request and its one answer. */
  private async call(request: { op: HostRequest["op"] } & Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const answer = new Promise<HostFrame>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    try { await this.write({ ...request, id } as HostRequest); } catch (error) { this.pending.delete(id); throw error; }
    const frame = await answer;
    if (frame.type === "error") throw Object.assign(new Error(frame.message), frame.code ? { code: frame.code } : {});
    return frame.type === "result" ? frame.result : undefined;
  }

  async start(spec: EngineSessionSpec, signal: AbortSignal): Promise<{ sessionId: string }> {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    await this.open(spec.resumeFrom);
    return await this.call({ op: "start", spec }) as { sessionId: string };
  }

  async *events(sessionId: string, afterSequence: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    await this.open(undefined);
    const id = this.nextId++;
    const queue = new FrameQueue();
    this.streams.set(id, queue);
    const stop = (): void => { void this.write({ id: this.nextId++, op: "abort", target: id }).catch(() => undefined); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      await this.write({ id, op: "events", sessionId, afterSequence });
      for (;;) {
        const frame = await queue.next();
        if (frame.type === "event") yield frame.event;
        else if (frame.type === "end") return;
        else if (frame.type === "error") throw Object.assign(new Error(frame.message), frame.code ? { code: frame.code } : {});
      }
    } finally {
      signal.removeEventListener("abort", stop);
      this.streams.delete(id);
    }
  }

  async toolResult(sessionId: string, result: EngineToolExecutionResult): Promise<void> { await this.call({ op: "toolResult", sessionId, result }); }
  async cancel(sessionId: string, reason: string): Promise<{ terminationConfirmed: boolean }> {
    if (!this.channel) return { terminationConfirmed: true };
    return await this.call({ op: "cancel", sessionId, reason }) as { terminationConfirmed: boolean };
  }
  async checkpoint(sessionId: string): Promise<Checkpoint> { return await this.call({ op: "checkpoint", sessionId }) as Checkpoint; }
  async steer(sessionId: string, messageId: string, message: string): Promise<void> { await this.call({ op: "steer", sessionId, messageId, message }); }
  async pause(sessionId: string): Promise<void> { await this.call({ op: "pause", sessionId }); }
  async continue(sessionId: string): Promise<void> { await this.call({ op: "continue", sessionId }); }
  async dispose(sessionId: string): Promise<void> { if (this.channel) await this.call({ op: "dispose", sessionId }); }

  /** Ends the attempt's sandbox and tidies its state; the supervisor calls it when the attempt is over, whatever way it ended. */
  async close(): Promise<{ terminationConfirmed: boolean }> {
    const opening = this.opening;
    if (opening) await opening.catch(() => undefined);
    const channel = this.channel;
    this.channel = undefined;
    const closed = channel ? await channel.close().catch(() => ({ terminationConfirmed: false })) : { terminationConfirmed: true };
    if (existsSync(this.options.stateRoot)) finishAttemptState(this.options.stateRoot, this.options.attemptId);
    return closed;
  }
}

/** The launcher image for engine sandboxes (the launcher names the same one; the two are separate executables and share no code). */
export const ENGINE_SANDBOX_IMAGE = "brain-sandbox-engine";
