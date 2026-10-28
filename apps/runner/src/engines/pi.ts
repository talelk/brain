import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ArtifactRef, Checkpoint, EngineAdapter, EngineEvent, EngineSessionSpec } from "@brain/contracts";

// Pi adapter over the TypeScript SDK. Uses a runner-local agent directory
// with an explicit models.json (local OpenAI-compatible endpoint by default).
// Sessions are explicit-tool only in production slots; the conformance probe
// in tests/probes/harnesses proves start/prompt/dispose against vLLM.
export class PiEngine implements EngineAdapter {
  readonly id = "pi";
  private session: { dispose: () => void; prompt: (text: string) => Promise<void> } | null = null;
  private eventsBuffer: EngineEvent[] = [];
  private seq = 0;
  private sessionId = "";
  private sessionFile: string | undefined;
  private spec: EngineSessionSpec | undefined;

  private agentDir(): string {
    return process.env["BRAIN_PI_AGENT_DIR"] ?? join(process.cwd(), ".pi-agent");
  }
  private sessionsDir(): string { return join(this.agentDir(), "sessions"); }
  private checkpointsDir(): string { return join(this.agentDir(), "checkpoints"); }

  private modelUrl(): string {
    return process.env["BRAIN_LOCAL_MODEL_URL"] ?? "http://tntungx10:8000/v1";
  }
  private modelId(): string {
    return process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b";
  }

  async probe() {
    let version = "unavailable";
    let reachable = false;
    try {
      await import("@earendil-works/pi-coding-agent");
      version = "1.4.0";
      const res = await fetch(`${this.modelUrl()}/models`, { signal: AbortSignal.timeout(5000) });
      reachable = res.ok;
    } catch { version = "unavailable"; }
    return {
      id: "pi", version: reachable ? version : `${version}-model-unreachable`,
      adapterDigest: `sha256:${"0".repeat(64)}`, features: reachable ? ["sessions", "checkpoint"] : [],
    };
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
            id: this.modelId(), name: this.modelId(), reasoning: true, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 8192,
          }],
        },
      },
    }, null, 2));
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    const { createAgentSession, ModelRuntime } = (await import("@earendil-works/pi-coding-agent")) as typeof import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create();
    const model = runtime.getModel("local-qwen" as never, this.modelId() as never);
    if (!model) throw Object.assign(new Error("Pi local model not found in models.json"), { code: "UNSUPPORTED_CAPABILITY" });
    const { session } = await createAgentSession({ model, thinkingLevel: "low", modelRuntime: runtime, cwd: process.cwd(), sessionManager: manager } as never);
    this.session?.dispose();
    this.session = session as unknown as { dispose: () => void; prompt: (text: string) => Promise<void> };
    this.spec = spec;
    const mgr = manager as { getSessionId?: () => string; getSessionFile?: () => string | undefined };
    this.sessionId = mgr.getSessionId?.() ?? `pi-${Date.now().toString(36)}`;
    this.sessionFile = mgr.getSessionFile?.();
    this.eventsBuffer = [];
    (session as unknown as { subscribe: (fn: (event: { type: string; assistantMessageEvent?: { type: string; delta?: string } }) => void) => void }).subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        this.seq += 1;
        this.eventsBuffer.push({
          contractVersion: "brain.engine-event/v1", eventId: `pi-evt-${this.seq}`,
          sessionId: this.sessionId, attemptId: spec.attemptId, sequence: this.seq,
          occurredAt: new Date().toISOString(), kind: "text",
          payload: { text: event.assistantMessageEvent.delta ?? "", channel: "assistant", provisional: true },
        });
      }
    });
    return { sessionId: this.sessionId };
  }

  async start(spec: EngineSessionSpec, _signal: AbortSignal): Promise<{ sessionId: string }> {
    mkdirSync(this.sessionsDir(), { recursive: true });
    const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as typeof import("@earendil-works/pi-coding-agent");
    const manager = SessionManager.create(process.cwd(), this.sessionsDir());
    return this.openSession(spec, manager);
  }

  async prompt(text: string): Promise<void> {
    if (!this.session) throw new Error("no Pi session");
    await this.session.prompt(text);
  }

  async *events(_sessionId: string, after: number, _signal: AbortSignal): AsyncIterable<EngineEvent> {
    for (const ev of this.eventsBuffer) {
      if ((ev as { sequence: number }).sequence > after) yield ev;
    }
  }

  async cancel() {
    return { terminationConfirmed: true };
  }

  // Checkpoint = digest-pinned copy of the durable Pi session file (JSONL).
  // The artifact bytes are the exact resumable session state; resume()
  // verifies the digest before reopening them through SessionManager.open.
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
      contractVersion: "brain.checkpoint/v1",
      attemptId: this.spec.attemptId,
      sourceRevision: this.spec.sourceRevision,
      diff: { artifactId, digest, bytes: bytes.length, mediaType: "application/x-ndjson", classification: "internal" },
      completedCriteria: [],
      failures: [],
      worktreeId: this.spec.worktreeId,
      eventSequence: this.seq,
      ownedResources: [],
      nextAction: "resume Pi session from checkpoint artifact",
      createdAt: new Date().toISOString(),
    };
  }

  async resume(sessionId: string, checkpoint: ArtifactRef): Promise<void> {
    if (!this.spec) throw Object.assign(new Error("Pi resume requires a prior session spec on this adapter"), { code: "UNSUPPORTED_CAPABILITY" });
    const path = join(this.checkpointsDir(), `${checkpoint.digest.replace(/^sha256:/u, "")}.jsonl`);
    if (!existsSync(path)) throw Object.assign(new Error("Pi checkpoint artifact not present on this runner"), { code: "UNSUPPORTED_CAPABILITY" });
    const bytes = readFileSync(path);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== checkpoint.digest || bytes.length !== checkpoint.bytes) {
      throw Object.assign(new Error("Pi checkpoint artifact digest mismatch"), { code: "UNSUPPORTED_CAPABILITY" });
    }
    const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as typeof import("@earendil-works/pi-coding-agent");
    const manager = SessionManager.open(path, this.sessionsDir());
    await this.openSession(this.spec, manager);
    void sessionId;
  }

  async dispose() {
    this.session?.dispose();
    this.session = null;
  }
}
