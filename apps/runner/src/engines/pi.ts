import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { sha256Digest } from "@brain/contracts";
import type { ArtifactRef, Checkpoint, EngineAdapter, EngineEvent, EngineSessionSpec } from "@brain/contracts";
import { EngineEventStream } from "./event-stream";

export class PiEngine implements EngineAdapter {
  readonly id = "pi";
  get defaultModelId(): string { return this.modelId(); }
  private session: { dispose: () => void; abort: () => Promise<void>; getSessionStats: () => { assistantMessages: number; tokens: {input:number;output:number;cacheRead:number;total:number};cost:number }; prompt: (text: string) => Promise<void> } | null = null;
  private seq = 0;
  private sessionId = "";
  private sessionFile: string | undefined;
  private spec: EngineSessionSpec | undefined;
  private stream = new EngineEventStream();
  private output = "";
  private failure: string | undefined;

  private agentDir(): string {
    return process.env["BRAIN_PI_AGENT_DIR"] ?? join(process.cwd(), ".pi-agent");
  }
  private sessionsDir(): string { return join(this.agentDir(), "sessions"); }
  private checkpointsDir(): string { return join(this.agentDir(), "checkpoints"); }
  private modelUrl(): string { return process.env["BRAIN_LOCAL_MODEL_URL"] ?? "http://tntungx10:8000/v1"; }
  private modelId(): string { return process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b"; }

  async probe() {
    let version = "unavailable";
    let reachable = false;
    try {
      await import("@earendil-works/pi-coding-agent");
      version = "1.4.0";
      const res = await fetch(`${this.modelUrl()}/models`, { signal: AbortSignal.timeout(5000) });
      reachable = res.ok && ((await res.json()) as { data?: {id:string}[] }).data?.some((model) => model.id === this.modelId()) === true;
    } catch { version = "unavailable"; }
    return {
      id: "pi", version: reachable ? version : `${version}-model-unreachable`,
      adapterDigest: sha256Digest(new Uint8Array(readFileSync(new URL(import.meta.url)))), features: reachable ? ["sessions", "checkpoint"] : [],
    };
  }

  private push(kind: EngineEvent["kind"], payload: EngineEvent["payload"]): void {
    const spec = this.spec;
    if (!spec) return;
    this.seq += 1;
    this.stream.push({
      contractVersion: "brain.engine-event/v1", eventId: `pi-evt-${this.seq}`,
      sessionId: this.sessionId, attemptId: spec.attemptId, sequence: this.seq,
      occurredAt: new Date().toISOString(), kind, payload,
    } as EngineEvent);
  }

  private async openSession(spec: EngineSessionSpec, manager: unknown): Promise<{ sessionId: string }> {
    const agentDir = this.agentDir();
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(this.sessionsDir(), { recursive: true });
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "local-qwen": {
          name: "Local Qwen (vLLM)", baseUrl: this.modelUrl(), api: "openai-completions", apiKey: "local-no-key",
          models: [{
            id: spec.modelId || this.modelId(), name: spec.modelId || this.modelId(), reasoning: true, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: Math.min(8192, spec.limits.maxTokens),
          }],
        },
      },
    }, null, 2));
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    const { createAgentSession, ModelRuntime } = (await import("@earendil-works/pi-coding-agent")) as typeof import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create();
    const model = runtime.getModel("local-qwen" as never, (spec.modelId || this.modelId()) as never);
    if (!model) throw Object.assign(new Error("Pi local model not found in models.json"), { code: "UNSUPPORTED_CAPABILITY" });
    if (spec.allowedTools.length > 0) throw new Error("Pi governed tool bindings are not configured; refusing native tool access");
    const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: spec.instructions,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      model, thinkingLevel: "low", modelRuntime: runtime, cwd: process.cwd(), agentDir,
      sessionManager: manager, tools: [], noTools: "all", resourceLoader,
    } as never);
    this.session?.dispose();
    this.session = session as unknown as { dispose: () => void; abort: () => Promise<void>; getSessionStats: () => { assistantMessages: number; tokens: {input:number;output:number;cacheRead:number;total:number};cost:number }; prompt: (text: string) => Promise<void> };
    const mgr = manager as { getSessionId?: () => string; getSessionFile?: () => string | undefined };
    this.sessionId = mgr.getSessionId?.() ?? `pi-${Date.now().toString(36)}`;
    this.sessionFile = mgr.getSessionFile?.();
    (session as unknown as { subscribe: (fn: (event: { type: string; message?: { role?: string; stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }; assistantMessageEvent?: { type: string; delta?: string } }) => void) => void }).subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        const text = event.assistantMessageEvent.delta ?? "";
        this.output += text;
        this.push("text", { text, channel: "assistant", provisional: true });
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const message = event.message;
        if (message.stopReason === "error" || message.stopReason === "aborted") this.failure = message.errorMessage ?? `Pi stopped: ${message.stopReason}`;
        if (!this.output && message.content) {
          const text = message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
          if (text) { this.output = text; this.push("text", { text, channel: "assistant", provisional: true }); }
        }
      }
    });
    return { sessionId: this.sessionId };
  }

  private async complete(spec: EngineSessionSpec): Promise<void> {
    try {
      if (!this.session) throw new Error("Pi session is unavailable");
      const prompt = `${spec.instructions.trim()}\n\nTask:\n${spec.task}`.trim();
      await this.session.prompt(prompt);
      if (this.failure) throw new Error(this.failure);
      const usage = this.session.getSessionStats();
      this.push("usage", { usageId: `pi-usage-${spec.attemptId}`, inputTokens: usage.tokens.input,
        outputTokens: usage.tokens.output, cachedInputTokens: usage.tokens.cacheRead,
        microUsd: Math.ceil(usage.cost*1000000), accounting: "final-total", estimated: false });
      if (usage.tokens.total > spec.limits.maxTokens || usage.cost*1000000 > spec.limits.maxMicroUsd || usage.assistantMessages > spec.limits.maxTurns) throw new Error("Pi execution exceeded its pinned token/cost/turn budget");
      const bytes = new TextEncoder().encode(this.output);
      const artifact = {
        artifactId: `pi-output-${spec.attemptId}`, digest: sha256Digest(bytes), bytes: bytes.length,
        mediaType: "text/plain", classification: "internal" as const,
      };
      this.push("artifact", { artifact, purpose: "output" });
      this.push("session.stopped", { reason: "completed", terminationConfirmed: true, output: artifact });
    } catch (e) {
      this.push("error", {
        error: { code: "DEPENDENCY_UNAVAILABLE", detail: e instanceof Error ? e.message : "Pi execution failed", retryable: true, correlationId: this.sessionId },
        phase: "stream", retryClass: "new-attempt",
      });
      this.push("session.stopped", { reason: "error", terminationConfirmed: true });
    } finally {
      this.stream.close();
    }
  }

  async start(spec: EngineSessionSpec, signal: AbortSignal): Promise<{ sessionId: string }> {
    this.spec = spec;
    this.seq = 0;
    this.output = "";
    this.failure = undefined;
    this.stream = new EngineEventStream();
    mkdirSync(this.sessionsDir(), { recursive: true });
    const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as typeof import("@earendil-works/pi-coding-agent");
    const manager = SessionManager.create(process.cwd(), this.sessionsDir());
    const started = await this.openSession(spec, manager);
    this.push("session.started", { engine: spec.engine });
    signal.addEventListener("abort", () => { void this.cancel(this.sessionId, "execution aborted"); }, { once: true });
    void this.complete(spec);
    return started;
  }

  async prompt(text: string): Promise<void> {
    if (!this.session) throw new Error("no Pi session");
    if (!this.spec) throw new Error("no pinned Pi session specification");
    this.stream = new EngineEventStream(); this.output = ""; this.failure = undefined;
    await this.complete({ ...this.spec, task: text });
  }

  async *events(_sessionId: string, after: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    yield* this.stream.after(after, signal);
  }

  async cancel(_sessionId?: string, _reason?: string) {
    await this.session?.abort();
    this.session?.dispose();
    this.session = null;
    this.stream.close();
    return { terminationConfirmed: true };
  }

  async checkpoint(sessionId: string): Promise<Checkpoint> {
    if (!this.spec || this.sessionId !== sessionId || !this.sessionFile || !existsSync(this.sessionFile)) {
      throw Object.assign(new Error("Pi session file unavailable for checkpoint"), { code: "UNSUPPORTED_CAPABILITY" });
    }
    const bytes = readFileSync(this.sessionFile);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    mkdirSync(this.checkpointsDir(), { recursive: true });
    const artifactId = `pi-checkpoint-${digest.slice(7, 23)}`;
    const dest = join(this.checkpointsDir(), `${digest.slice(7)}.jsonl`);
    if (!existsSync(dest)) copyFileSync(this.sessionFile, dest);
    return {
      contractVersion: "brain.checkpoint/v1", attemptId: this.spec.attemptId, sourceRevision: this.spec.sourceRevision,
      diff: { artifactId, digest, bytes: bytes.length, mediaType: "application/x-ndjson", classification: "internal" },
      completedCriteria: [], failures: [], worktreeId: this.spec.worktreeId, eventSequence: this.seq,
      ownedResources: [], nextAction: "resume Pi session from checkpoint artifact", createdAt: new Date().toISOString(),
    };
  }

  async resume(sessionId: string, checkpoint: ArtifactRef): Promise<void> {
    if (!this.spec) throw Object.assign(new Error("Pi resume requires a prior session spec on this adapter"), { code: "UNSUPPORTED_CAPABILITY" });
    const path = join(this.checkpointsDir(), `${checkpoint.digest.replace(/^sha256:/u, "")}.jsonl`);
    if (!existsSync(path)) throw Object.assign(new Error("Pi checkpoint artifact not present on this runner"), { code: "UNSUPPORTED_CAPABILITY" });
    const bytes = readFileSync(path);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== checkpoint.digest || bytes.length !== checkpoint.bytes) throw Object.assign(new Error("Pi checkpoint artifact digest mismatch"), { code: "UNSUPPORTED_CAPABILITY" });
    const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as typeof import("@earendil-works/pi-coding-agent");
    await this.session?.abort();
    const manager = SessionManager.open(path, this.sessionsDir());
    this.spec = { ...this.spec, task: "Resume the pinned session." };
    await this.openSession(this.spec, manager);
    this.sessionId = sessionId;
  }

  async dispose(_sessionId?: string) {
    this.session?.dispose();
    this.session = null;
    this.stream.close();
  }
}
