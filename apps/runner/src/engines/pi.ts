import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelKeyEnvName, resolveModelKey, sha256Digest } from "@brain/contracts";
import type { ArtifactRef, Checkpoint, EngineAdapter, EngineEvent, EngineSessionSpec, EngineToolBinding, EngineToolExecutionResult, JsonValue } from "@brain/contracts";
import { EngineEventStream } from "./event-stream";
import { engineFailureDetail, QUOTA_TEXT } from "./failure-detail";
import { holdsCompleteObject } from "./json-reply";
import { attemptLimitsNotice, finalTurnNotice, overAllowanceReason, REPEAT_BUDGET, toolCallCeiling, wrapUpReason } from "./limits";
import { hostedMicroUsd, type HostedPrices } from "./pricing";
import { installedVersion } from "./package-version";
import { GovernedToolCalls } from "./tool-calls";

/**
 * Where a hosted-model attempt calls (ADR 0023): the Governor names the place; the API key comes from this runner's own environment
 * and is never part of any job. Only an attempt the Governor routed (a check or a second attempt after a model slip) carries one, with the
 * model's prices: the attempt's spend is its tokens times those prices, so it reaches the dollar caps.
 */
export interface HostedRoute extends HostedPrices {
  readonly routeId: string;
  readonly baseUrl: string;
  readonly model: string;
  /** The key's reference (ADR 0052): resolved from this runner's environment as BRAIN_MODEL_KEY_<REFERENCE>, never carried in a job. */
  readonly keyRef: string;
}

/** What an attempt is told when this runner has no key for a route: the route is skipped, nothing was sent anywhere. */
export const missingKeyMessage = (keyRef: string): string => `The model route needs its API key on this runner (${modelKeyEnvName(keyRef)}); the attempt was not sent anywhere`;

type PiSession = { dispose: () => void; abort: () => Promise<void>; abortRetry: () => void; getSessionStats: () => { assistantMessages: number; tokens: { input: number; output: number; cacheRead: number; total: number }; cost: number }; prompt: (text: string) => Promise<void>; steer: (text: string) => Promise<unknown>; agent: { onPayload?: (payload: unknown, model: unknown) => Promise<unknown> | unknown }; readonly isStreaming: boolean };

type SessionEvent = { type: string; errorMessage?: string; message?: { role?: string; stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> } };

export class PiEngine implements EngineAdapter {
  readonly id = "pi";
  get defaultModelId(): string { return this.route?.model ?? this.modelId(); }
  private session: PiSession | null = null;
  private seq = 0;
  private sessionId = "";
  private sessionFile: string | undefined;
  private spec: EngineSessionSpec | undefined;
  private stream = new EngineEventStream();
  private output = "";
  private failure: string | undefined;
  private tokensAtLastCheck = 0;
  private toolsEnded = false;
  private keepAnswer = false;
  private toolCalls: GovernedToolCalls | undefined;
  constructor(private readonly toolBindings: readonly EngineToolBinding[] = [], private readonly route?: HostedRoute) {}

  private agentDir(): string {
    return process.env["BRAIN_PI_AGENT_DIR"] ?? join(process.cwd(), ".pi-agent");
  }
  private sessionsDir(): string { return join(this.agentDir(), "sessions"); }
  private checkpointsDir(): string { return join(this.agentDir(), "checkpoints"); }
  private modelUrl(): string { return process.env["BRAIN_LOCAL_MODEL_URL"] ?? "http://tntungx10:8000/v1"; }
  private modelId(): string { return process.env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b"; }

  async probe() {
    let reachable = false;
    try {
      await import("@earendil-works/pi-coding-agent");
      const res = await fetch(`${this.modelUrl()}/models`, { redirect: "error", headers: process.env["BRAIN_LOCAL_MODEL_API_KEY"] ? { authorization: `Bearer ${process.env["BRAIN_LOCAL_MODEL_API_KEY"]}` } : {}, signal: AbortSignal.timeout(5000) });
      reachable = res.ok && ((await res.json()) as { data?: {id:string}[] }).data?.some((model) => model.id === this.modelId()) === true;
    } catch { reachable = false; }
    // The version is the installed package's own; whether the model answers is a feature (sessions), never part of the version.
    const version = installedVersion("@earendil-works/pi-coding-agent");
    return {
      id: "pi", ...(version ? { version } : {}),
      adapterDigest: sha256Digest(new Uint8Array(readFileSync(new URL(import.meta.url)))),
      features: reachable ? ["sessions", "checkpoint", "resume", "steer"] : [],
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
    // A routed attempt reads its own models file, named explicitly, so it can never change which model another attempt of this process uses.
    const hostedKey = this.route ? resolveModelKey(this.route.keyRef) : undefined;
    if (this.route && !hostedKey) throw Object.assign(new Error(`${missingKeyMessage(this.route.keyRef)}`), { code: "UNSUPPORTED_CAPABILITY" });
    const providerId = this.route ? "hosted-model" : "local-qwen";
    const modelsFile = join(agentDir, this.route ? `models-hosted-${spec.jobId}.json` : "models.json");
    writeFileSync(modelsFile, JSON.stringify({
      providers: {
        [providerId]: {
          name: this.route ? "Hosted model" : "Local Qwen (vLLM)", baseUrl: this.route?.baseUrl ?? this.modelUrl(), api: "openai-completions", apiKey: hostedKey ?? (process.env["BRAIN_LOCAL_MODEL_API_KEY"] || "local-no-key"),
          models: [{
            id: spec.modelId || this.modelId(), name: spec.modelId || this.modelId(), reasoning: true, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: Math.min(spec.limits.maxTokens, 16384, Math.max(8192, spec.limits.maxTokens - 4096)),
          }],
        },
      },
    }, null, 2), { mode: 0o600 });
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    const { createAgentSession, ModelRuntime, SettingsManager } = (await import("@earendil-works/pi-coding-agent")) as typeof import("@earendil-works/pi-coding-agent");
    // A provider's Retry-After is read, not slept on: a delay above 1 ms fails the request at once with "Server requested Ns retry delay", so the
    // wait is the Governor's to schedule (ADR 0033). A failure that named no delay gets the vendor's one quick retry.
    const settings = SettingsManager.create(process.cwd(), agentDir);
    settings.applyOverrides({ retry: { provider: { maxRetries: 1, maxRetryDelayMs: 1 } } });
    const runtime = await ModelRuntime.create(this.route ? { modelsPath: modelsFile } : undefined);
    const model = runtime.getModel(providerId as never, (spec.modelId || this.defaultModelId) as never);
    if (!model) throw Object.assign(new Error("Pi local model not found in models.json"), { code: "UNSUPPORTED_CAPABILITY" });
    if (spec.allowedTools.some((allowed) => !this.toolBindings.some((binding) => binding.release.id === allowed.id && binding.release.digest === allowed.digest))) throw new Error("Pi Agent tool definitions are incomplete; refusing execution");
    // The allowance is judged at every tool call (a turn boundary), not once at the end: a model left to run can use several times its allowance first.
    const calls = new GovernedToolCalls(this.toolBindings, spec, (kind, payload) => this.push(kind, payload), {
      maxCalls: this.callCeiling(spec), maxRepeats: REPEAT_BUDGET,
      refuse: () => this.allowanceStop(spec),
      note: (used) => `tool calls used: ${used} of ${this.callCeiling(spec)}; tokens used: ${this.tokensUsed().toLocaleString("en-US")} of ${spec.limits.maxTokens.toLocaleString("en-US")}. If this answered what the task asks, write the final answer now.`,
      exhausted: (why) => this.endTools(spec, why),
    });
    this.toolCalls = calls;
    const customTools = this.toolBindings.map((binding) => ({
      name: calls.names().find((name) => name === `brain_${binding.release.id.replace(/[^A-Za-z0-9_]/gu, "_")}`)!,
      label: binding.release.id, description: `Governed ${binding.effectClass} tool ${binding.release.id}; inputs are validated and execution is isolated by Brain.`,
      parameters: binding.inputSchema,
      execute: async (toolCallId: string, params: unknown) => ({ content: [{ type: "text", text: await calls.execute(`brain_${binding.release.id.replace(/[^A-Za-z0-9_]/gu, "_")}`, toolCallId, params as JsonValue) }] }),
    }));
    const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: spec.instructions,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      model, thinkingLevel: "low", modelRuntime: runtime, cwd: process.cwd(), agentDir,
      sessionManager: manager, settingsManager: settings, tools: calls.names(), ...(calls.names().length ? { customTools } : { noTools: "all" }), resourceLoader,
    } as never);
    this.session?.dispose();
    this.session = session as unknown as PiSession;
    this.guardRequests(this.session);
    const mgr = manager as { getSessionId?: () => string; getSessionFile?: () => string | undefined };
    this.sessionId = mgr.getSessionId?.() ?? `pi-${Date.now().toString(36)}`;
    this.sessionFile = mgr.getSessionFile?.();
    (session as unknown as { subscribe: (fn: (event: SessionEvent) => void) => void }).subscribe((event) => this.observe(event));
    return { sessionId: this.sessionId };
  }

  /** What the model said and how each of its messages ended, as the vendor session reports it. */
  private observe(event: SessionEvent): void {
    // A quota or rate limit is not retried in place: the vendor session would send the same request again; the Governor waits for the reset.
    if (event.type === "auto_retry_start" && QUOTA_TEXT.test(event.errorMessage ?? "")) queueMicrotask(() => this.session?.abortRetry());
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const message = event.message;
    // The first cause stands: an attempt stopped for its allowance ends with an "aborted" message that must not hide that reason.
    if (!this.keepAnswer && (message.stopReason === "error" || message.stopReason === "aborted")) this.failure ??= message.errorMessage ?? `Pi stopped: ${message.stopReason}`;
    // The answer is the last message the model wrote: what it said while it was still calling tools is narration, never part of the JSON deliverable.
    const text = (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
    const narration = (message.content ?? []).some((part) => part.type === "toolCall");
    this.output = text;
    if (text) this.push("text", { text, channel: narration ? "diagnostic" : "assistant", provisional: true });
    // A reasoning model can spend its whole output allowance thinking and never write the answer; say so instead of "no output".
    if (message.stopReason === "length" && !this.output.trim()) this.failure = "the model used its whole output limit before writing an answer";
  }

  /** Micro-USD for the session's totals: tokens x the route's prices on the hosted route; the self-hosted model costs nothing. */
  private microUsd(stats: { tokens: { input: number; output: number; cacheRead: number }; cost: number } | undefined): number {
    if (!stats) return 0;
    return this.route ? hostedMicroUsd(this.route, stats.tokens) : Math.ceil(stats.cost * 1_000_000);
  }

  /** What this attempt has used so far, from the vendor session's own totals. */
  private use(): { tokens: number; microUsd: number; turns: number; lastTurnTokens: number } {
    const stats = this.session?.getSessionStats();
    const tokens = stats?.tokens.total ?? 0;
    // Called once per tool call, that is once per turn: the difference between two calls is what the turn in between cost.
    const lastTurnTokens = tokens - this.tokensAtLastCheck;
    this.tokensAtLastCheck = tokens;
    return { tokens, microUsd: this.microUsd(stats), turns: stats?.assistantMessages ?? 0, lastTurnTokens };
  }

  /**
   * Asked before each tool call. Within the allowance: nothing. Nearly used up: the call is refused and the model told to write its answer.
   * Past it while still calling tools: the session is stopped with the numbers as the reason (a finished answer is never stopped, see complete()).
   */
  private allowanceStop(spec: EngineSessionSpec): string | undefined {
    if (this.failure) return "This attempt is ending. Do not call more tools.";
    const use = this.use();
    const over = overAllowanceReason(use, spec.limits);
    if (over) {
      // An answer that is already a complete JSON object is the deliverable: stopping the session loses nothing, so it is kept; any other
      // text cannot be told from a half-written one, so the attempt fails with the numbers as its reason.
      if (holdsCompleteObject(this.output)) this.keepAnswer = true; else this.failure = over;
      void this.session?.abort().catch(() => undefined);
      return "This attempt's allowance is used up. Do not call more tools.";
    }
    const wrapUp = wrapUpReason(use, spec.limits);
    // A tool answer is easy to talk past, and a refused call still costs a whole turn at the full prompt size: the tools are taken away so the
    // next turn can only be the answer.
    if (wrapUp) this.endTools(spec, wrapUp);
    return wrapUp;
  }

  /** The tool calls this attempt may make: from its task, never more than the agent's turn limit. */
  private callCeiling(spec: EngineSessionSpec): number { return toolCallCeiling(spec.task, spec.limits.maxTurns); }

  private tokensUsed(): number { return this.session?.getSessionStats().tokens.total ?? 0; }

  /**
   * Once tools have ended, every further request to the model goes out without a tool list. The vendor session would send an empty list (it
   * does when a conversation holds tool calls and none is offered) and an OpenAI-compatible server such as vLLM rejects that: the field must be
   * absent. Without tools the model cannot call one, and the prompt no longer carries their definitions.
   */
  private guardRequests(session: PiSession): void {
    const inherited = session.agent.onPayload;
    session.agent.onPayload = async (payload, model) => {
      const base = (await inherited?.(payload, model)) ?? payload;
      if (!this.toolsEnded || base === null || typeof base !== "object") return base;
      const { tools: _tools, tool_choice: _choice, ...rest } = base as Record<string, unknown>;
      return rest;
    };
  }

  /**
   * Takes the tools away and tells the model, once, exactly how many tokens are left: the next request carries no tools (see guardRequests) and
   * the message reaches the model at that turn boundary. The model has nothing left to call, so its next turn is the final answer.
   */
  private endTools(spec: EngineSessionSpec, why: string): void {
    if (this.toolsEnded) return;
    this.toolsEnded = true;
    void this.session?.steer(finalTurnNotice(why, spec.limits.maxTokens - this.tokensUsed())).catch(() => undefined);
  }

  private async complete(spec: EngineSessionSpec): Promise<void> {
    try {
      if (!this.session) throw new Error("Pi session is unavailable");
      // The instructions are this session's system prompt already; sending them again as the first message would re-send them on every turn.
      const prompt = this.toolBindings.length > 0 && spec.allowedTools.length > 0 ? `${spec.task}\n\n${attemptLimitsNotice(this.callCeiling(spec), spec.limits.maxTokens)}` : spec.task;
      await this.session.prompt(prompt);
      // What was used is reported whether or not the attempt succeeded: a stopped attempt spent its tokens too.
      const usage = this.session.getSessionStats();
      this.push("usage", { usageId: `pi-usage-${spec.attemptId}`, inputTokens: usage.tokens.input,
        outputTokens: usage.tokens.output, cachedInputTokens: usage.tokens.cacheRead,
        microUsd: this.microUsd(usage), accounting: "final-total", estimated: false });
      if (this.failure) throw new Error(this.failure);
      // A finished answer is kept whatever it cost: the spend is reported above and charged, and throwing the answer away would only pay for it twice.
      const bytes = new TextEncoder().encode(this.output);
      const artifact = {
        artifactId: `pi-output-${spec.attemptId}`, digest: sha256Digest(bytes), bytes: bytes.length,
        mediaType: "text/plain", classification: "internal" as const,
      };
      this.push("artifact", { artifact, purpose: "output" });
      this.push("session.stopped", { reason: "completed", terminationConfirmed: true, output: artifact });
    } catch (e) {
      this.push("error", {
        error: { code: "DEPENDENCY_UNAVAILABLE", detail: engineFailureDetail(e instanceof Error ? e.message : "Pi execution failed"), retryable: true, correlationId: this.sessionId },
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
    this.tokensAtLastCheck = 0;
    this.toolsEnded = false;
    this.keepAnswer = false;
    this.stream = new EngineEventStream();
    mkdirSync(this.sessionsDir(), { recursive: true });
    const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as typeof import("@earendil-works/pi-coding-agent");
    // A resumed session continues a saved conversation: forked into this worktree, never opened as the stored file itself (the checkpoint stays
    // exactly as it was taken), and it is a new session with its own id. A checkpoint this runner does not hold is refused before anything starts.
    const manager = spec.resumeFrom ? SessionManager.forkFrom(this.heldCheckpoint(spec.resumeFrom), process.cwd(), this.sessionsDir()) : SessionManager.create(process.cwd(), this.sessionsDir());
    const started = await this.openSession(spec, manager);
    this.push("session.started", { engine: spec.engine });
    signal.addEventListener("abort", () => { void this.cancel(this.sessionId, "execution aborted"); }, { once: true });
    void this.complete(spec);
    return started;
  }

  async prompt(text: string): Promise<void> {
    if (!this.session) throw new Error("no Pi session");
    if (!this.spec) throw new Error("no pinned Pi session specification");
    this.stream = new EngineEventStream(); this.output = ""; this.failure = undefined; this.keepAnswer = false;
    await this.complete({ ...this.spec, task: text });
  }

  async *events(_sessionId: string, after: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    yield* this.stream.after(after, signal);
  }

  async toolResult(_sessionId: string, result: EngineToolExecutionResult): Promise<void> {
    if (!this.toolCalls) throw new Error("Pi tool broker is not initialized");
    this.toolCalls.complete(result);
  }

  /**
   * Pi steering: the message is injected into the live vendor session; the
   * engine applies it at its next turn boundary. Without a live session there
   * is nothing to steer — refused with the typed unsupported error instead of
   * queueing a message no turn will ever pick up.
   */
  async steer(sessionId: string, messageId: string, message: string): Promise<void> {
    if (!this.session || this.sessionId !== sessionId) {
      throw Object.assign(new Error(`Pi steering requires the live session, not ${sessionId}`), { code: "UNSUPPORTED_CAPABILITY" });
    }
    try {
      // Steering only exists while a run streams; an idle session has nothing to steer (#30).
      if (!this.session.isStreaming) throw new Error("no run is streaming");
      await this.session.steer(`[steer:${messageId}] ${message}`);
    } catch (e) {
      throw Object.assign(new Error(`Pi session refused the steering message: ${e instanceof Error ? e.message : String(e)}`), { code: "UNSUPPORTED_CAPABILITY" });
    }
  }

  async cancel(_sessionId?: string, _reason?: string) {
    this.toolCalls?.clear();
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
    const digest = sha256Digest(bytes);
    mkdirSync(this.checkpointsDir(), { recursive: true });
    const artifactId = `pi-checkpoint-${digest.slice(7, 23)}`;
    const dest = join(this.checkpointsDir(), `${digest.slice(7)}.jsonl`);
    if (!existsSync(dest)) copyFileSync(this.sessionFile, dest);
    this.pruneCheckpoints(dest);
    return {
      contractVersion: "brain.checkpoint/v2", attemptId: this.spec.attemptId, sourceRevision: this.spec.sourceRevision,
      // The Pi transcript is an engine warm-start artifact, not the source diff (#29).
      engineState: { artifactId, digest, bytes: bytes.length, mediaType: "application/x-ndjson", classification: "internal" },
      completedCriteria: [], failures: [], worktreeId: this.spec.worktreeId, eventSequence: this.seq,
      ownedResources: [], nextAction: "resume Pi session from checkpoint artifact", createdAt: new Date().toISOString(),
    };
  }

  /** The path of a saved conversation this runner holds, checked against the digest and size it was saved with. */
  private heldCheckpoint(checkpoint: ArtifactRef): string {
    const path = join(this.checkpointsDir(), `${checkpoint.digest.replace(/^sha256:/u, "")}.jsonl`);
    if (!existsSync(path)) throw Object.assign(new Error(`The checkpoint is not on this runner: Pi keeps a saved conversation on the runner that took it, and this runner has no copy of ${checkpoint.digest.slice(0, 19)}`), { code: "UNSUPPORTED_CAPABILITY" });
    const bytes = readFileSync(path);
    if (sha256Digest(bytes) !== checkpoint.digest || bytes.length !== checkpoint.bytes) throw Object.assign(new Error(`The saved conversation ${checkpoint.digest.slice(0, 19)} on this runner does not match the checkpoint, so it is not used`), { code: "UNSUPPORTED_CAPABILITY" });
    return path;
  }

  /** Only the newest saved conversations are kept: each is a whole transcript, and one is taken for every attempt that did not finish. */
  private pruneCheckpoints(keep: string, keepNewest = 50): void {
    const files = readdirSync(this.checkpointsDir()).filter((name) => name.endsWith(".jsonl") && join(this.checkpointsDir(), name) !== keep).map((name) => ({ name, at: statSync(join(this.checkpointsDir(), name)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const old of files.slice(keepNewest - 1)) rmSync(join(this.checkpointsDir(), old.name), { force: true });
  }

  async dispose(_sessionId?: string) {
    this.session?.dispose();
    this.session = null;
    this.stream.close();
  }
}
