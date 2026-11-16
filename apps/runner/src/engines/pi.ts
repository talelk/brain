import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@brain/contracts";
import { EngineEventStream } from "./event-stream";
import { engineFailureDetail, QUOTA_TEXT } from "./failure-detail";
import { holdsCompleteObject } from "./json-reply";
import { finalTurnNotice, overAllowanceReason, wrapUpReason } from "./limits";
import { installedVersion } from "./package-version";
import type { EngineAdapter, EngineEvent, EngineSessionSpec, NativeToolNames } from "./port";
import { boundedToolText, engineToolDescription, ToolRequests } from "./tool-calls";

const PACKAGE = "@earendil-works/pi-coding-agent";

/** Pi's own tools at each level: reading and searching, then editing and the shell. */
export const PI_NATIVE: NativeToolNames = { none: [], read: ["read", "grep", "find", "ls"], all: ["read", "grep", "find", "ls", "edit", "write", "bash"] };

/** The offer names a route, not a model, so the window is not known here; this is what compaction assumes. */
const CONTEXT_WINDOW = 200_000;
const PROVIDER = "brain";

type PiSession = {
  dispose: () => void; abort: () => Promise<void>; abortRetry: () => void; prompt: (text: string) => Promise<void>; steer: (text: string) => Promise<unknown>;
  getSessionStats: () => { assistantMessages: number; tokens: { input: number; output: number; cacheRead: number; total: number }; cost: number };
  subscribe: (listener: (event: SessionEvent) => void) => void;
  agent: { onPayload?: (payload: unknown, model: unknown) => Promise<unknown> | unknown; prepareNextTurnWithContext?: (turn: unknown, signal?: AbortSignal) => Promise<unknown> | unknown };
};

type SessionEvent = {
  type: string; errorMessage?: string; toolCallId?: string; toolName?: string; args?: unknown; isError?: boolean;
  result?: { content?: Array<{ type: string; text?: string }> } | string;
  message?: { role?: string; stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> };
};

/** The text of a native tool's result, as the vendor session reports it. */
function resultText(result: SessionEvent["result"]): string {
  if (typeof result === "string") return result;
  return (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

/**
 * Pi (the pi coding agent SDK). The model is the Governor's gateway, as an OpenAI-compatible provider written to this attempt's own
 * models file. Pi's own tools are enabled at the agent's native level and work in the working copy; workspace tools are custom tools
 * whose calls go to the runner.
 */
export class PiEngine implements EngineAdapter {
  readonly id = "pi";
  private session: PiSession | null = null;
  private stream = new EngineEventStream();
  private requests: ToolRequests | undefined;
  private output = "";
  private failure: { reason: "limit" | "error"; detail: string } | undefined;
  private tokensAtLastCheck = 0;
  private toolsEnded = false;
  private keepAnswer = false;

  async probe() {
    let ready = false;
    try { await import(PACKAGE); ready = true; } catch { ready = false; }
    const version = installedVersion(PACKAGE);
    return { id: this.id, ...(version ? { version } : {}), ready };
  }

  private push(event: EngineEvent): void { this.stream.push(event); }

  private async openSession(spec: EngineSessionSpec): Promise<PiSession> {
    const agentDir = join(spec.stateDir, "pi");
    const sessionsDir = join(agentDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const cwd = spec.workDir ?? spec.stateDir;
    // The attempt's own models file, named explicitly: the gateway address and this attempt's token, never another attempt's.
    const modelsFile = join(agentDir, "models.json");
    writeFileSync(modelsFile, JSON.stringify({
      providers: {
        [PROVIDER]: {
          name: "Brain model gateway", baseUrl: spec.model.baseUrl, api: "openai-completions", apiKey: spec.model.token,
          models: [{
            id: spec.model.name, name: spec.model.name, reasoning: true, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: CONTEXT_WINDOW, maxTokens: Math.min(spec.limits.maxTokens, 16384, Math.max(8192, spec.limits.maxTokens - 4096)),
          }],
        },
      },
    }, null, 2), { mode: 0o600 });
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = (await import(PACKAGE)) as typeof import("@earendil-works/pi-coding-agent");
    // A provider's Retry-After is read, not slept on: the wait is the Governor's to schedule. A failure that named no delay gets one quick retry.
    const settings = SettingsManager.create(cwd, agentDir);
    settings.applyOverrides({ retry: { provider: { maxRetries: 1, maxRetryDelayMs: 1 } } });
    const runtime = await ModelRuntime.create({ modelsPath: modelsFile });
    const model = runtime.getModel(PROVIDER as never, spec.model.name as never);
    if (!model) throw new Error("Pi did not find the gateway model in its models file");
    const requests = new ToolRequests(spec.tools, (event) => this.push(event), { maxCalls: spec.limits.maxTurns, refuse: () => this.allowanceStop(spec) });
    this.requests = requests;
    const customTools = requests.entries().map(([name, tool]) => ({
      name, label: tool.name, description: engineToolDescription(tool), parameters: tool.inputSchema,
      execute: async (_toolCallId: string, params: unknown) => ({ content: [{ type: "text", text: await requests.execute(name, params as JsonValue) }] }),
    }));
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: spec.instructions });
    await resourceLoader.reload();
    // The allowlist is the whole tool set: Pi's own tools at the agent's level and the workspace tools, nothing else.
    const enabled = [...PI_NATIVE[spec.native], ...requests.names()];
    const { session } = await createAgentSession({
      model, thinkingLevel: "low", modelRuntime: runtime, cwd, agentDir, sessionManager: SessionManager.create(cwd, sessionsDir), settingsManager: settings, resourceLoader,
      ...(enabled.length > 0 ? { tools: enabled } : { noTools: "all" }), ...(customTools.length > 0 ? { customTools } : {}),
    } as never);
    const opened = session as unknown as PiSession;
    this.guardRequests(opened);
    this.guardTurnBoundary(opened, spec);
    opened.subscribe((event) => this.observe(event, spec));
    return opened;
  }

  /** What the model said, how each of its messages ended and what Pi's own tools did, as the vendor session reports it. */
  private observe(event: SessionEvent, spec: EngineSessionSpec): void {
    // A quota or rate limit is not retried in place: the Governor waits for the reset.
    if (event.type === "auto_retry_start" && QUOTA_TEXT.test(event.errorMessage ?? "")) queueMicrotask(() => this.session?.abortRetry());
    const native = event.toolName !== undefined && PI_NATIVE[spec.native].includes(event.toolName);
    if (event.type === "tool_execution_start" && native) this.push({ kind: "native.call", callId: event.toolCallId ?? "", name: event.toolName!, input: (event.args ?? {}) as JsonValue });
    if (event.type === "tool_execution_end" && native) this.push({ kind: "native.result", callId: event.toolCallId ?? "", ok: event.isError !== true, output: boundedToolText(resultText(event.result)) });
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const message = event.message;
    // The first cause stands: an attempt stopped for its allowance ends with an "aborted" message that must not hide that reason.
    if (!this.keepAnswer && (message.stopReason === "error" || message.stopReason === "aborted")) this.failure ??= { reason: "error", detail: message.errorMessage ?? `Pi stopped: ${message.stopReason}` };
    // The answer is the last message the model wrote: what it said while it was still calling tools is narration.
    const text = (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
    const narration = (message.content ?? []).some((part) => part.type === "toolCall");
    this.output = text;
    if (text) this.push({ kind: "text", channel: narration ? "diagnostic" : "assistant", text });
    // A reasoning model can spend its whole output allowance thinking and never write the answer; say so instead of "no output".
    if (message.stopReason === "length" && !this.output.trim()) this.failure = { reason: "error", detail: "the model used its whole output limit before writing an answer" };
  }

  /** The session's totals from the vendor session. Money is 0: the gateway prices the calls, the runner does not know the prices. */
  private usage() {
    const stats = this.session?.getSessionStats();
    return { inputTokens: stats?.tokens.input ?? 0, outputTokens: stats?.tokens.output ?? 0, cachedInputTokens: stats?.tokens.cacheRead ?? 0, microUsd: Math.ceil((stats?.cost ?? 0) * 1_000_000), turns: stats?.assistantMessages ?? 0, total: stats?.tokens.total ?? 0 };
  }

  private reportUsage(): void {
    const { total: _total, ...usage } = this.usage();
    this.push({ kind: "usage", ...usage });
  }

  /**
   * Asked at every turn boundary and before each workspace tool call. Within the limits: nothing. Nearly used up: tools are taken away and
   * the model is told to write its answer. Past them while still working: the session is stopped with the numbers as the reason.
   */
  private allowanceStop(spec: EngineSessionSpec): string | undefined {
    if (this.failure) return "This attempt is ending. Do not call more tools.";
    const now = this.usage();
    const use = { tokens: now.total, microUsd: now.microUsd, turns: now.turns, lastTurnTokens: now.total - this.tokensAtLastCheck };
    this.tokensAtLastCheck = now.total;
    const over = overAllowanceReason(use, spec.limits);
    if (over) {
      // An answer that is already a complete JSON object is the deliverable: stopping loses nothing, so it is kept. Any other text
      // cannot be told from a half-written one, so the attempt fails with the numbers as its reason.
      if (holdsCompleteObject(this.output)) this.keepAnswer = true; else this.failure = { reason: "limit", detail: over };
      void this.session?.abort().catch(() => undefined);
      return "This attempt's allowance is used up. Do not call more tools.";
    }
    const wrapUp = wrapUpReason(use, spec.limits);
    if (wrapUp) this.endTools(spec, wrapUp);
    return wrapUp;
  }

  /**
   * Once tools have ended, every further request to the model goes out without a tool list. The vendor session would send an empty list
   * and an OpenAI-compatible server rejects that: the field must be absent.
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

  /** The turn boundary (after a turn, before the next request): where the limits are judged for a session that only uses Pi's own tools. */
  private guardTurnBoundary(session: PiSession, spec: EngineSessionSpec): void {
    const inherited = session.agent.prepareNextTurnWithContext;
    session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      this.reportUsage();
      this.allowanceStop(spec);
      return inherited?.(turn, signal);
    };
  }

  /** Takes the tools away and tells the model, once, how many tokens are left: its next turn can only be the answer. */
  private endTools(spec: EngineSessionSpec, why: string): void {
    if (this.toolsEnded) return;
    this.toolsEnded = true;
    void this.session?.steer(finalTurnNotice(why, spec.limits.maxTokens - this.usage().total)).catch(() => undefined);
  }

  private async complete(spec: EngineSessionSpec, stream: EngineEventStream): Promise<void> {
    try {
      this.session = await this.openSession(spec);
      // The instructions are the session's system prompt already; sending them again as the first message would send them every turn.
      await this.session.prompt(spec.task);
      // What was used is reported whether or not the attempt succeeded: a stopped attempt spent its tokens too.
      this.reportUsage();
      if (this.failure) throw new Error(this.failure.detail);
      stream.push({ kind: "stopped", reason: "completed" });
    } catch (error) {
      const limit = this.failure?.reason === "limit";
      stream.push({ kind: "stopped", reason: limit ? "limit" : "error", detail: limit ? this.failure!.detail : engineFailureDetail(error instanceof Error ? error.message : "Pi execution failed") });
    } finally {
      stream.close();
    }
  }

  async start(spec: EngineSessionSpec, signal: AbortSignal): Promise<void> {
    this.session?.dispose();
    this.session = null;
    this.output = "";
    this.failure = undefined;
    this.tokensAtLastCheck = 0;
    this.toolsEnded = false;
    this.keepAnswer = false;
    this.stream = new EngineEventStream();
    signal.addEventListener("abort", () => { void this.cancel(); }, { once: true });
    void this.complete(spec, this.stream);
  }

  events(signal: AbortSignal): AsyncIterable<EngineEvent> { return this.stream.read(signal); }

  async toolResult(callId: string, text: string): Promise<void> {
    if (!this.requests) throw new Error("no Pi session is running");
    this.requests.complete(callId, text);
  }

  async cancel(): Promise<void> {
    this.requests?.clear();
    await this.session?.abort().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.requests?.clear();
    this.session?.dispose();
    this.session = null;
    this.stream.close();
  }
}
