import type { EngineAdapter, EngineSessionSpec, EngineToolBinding, EngineToolExecutionResult, JsonValue, ReleaseRef } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { decodeModelJson } from "./json-reply";
export { decodeModelJson, repairJsonStrings } from "./json-reply";
import { FixtureEngine } from "./fixture";
import { PiEngine, type HostedRoute } from "./pi";
import { ClaudeEngine } from "./claude";
import { AcpEngine } from "./acp";
import { OpenCodeEngine } from "./opencode";

export function selectEngine(configured: string | undefined, toolBindings: readonly EngineToolBinding[] = [], route?: HostedRoute): EngineAdapter | undefined {
  switch (configured) {
    case "fixture": return new FixtureEngine(toolBindings);
    case "pi": return new PiEngine(toolBindings, route);
    case "claude": return new ClaudeEngine(toolBindings, route);
    case "acp": return new AcpEngine({ toolBindings });
    case "opencode": return new OpenCodeEngine(toolBindings);
    default: return undefined;
  }
}

/**
 * The engine prompt of a workflow-driven agent step: the Governor-built context
 * pack (when the step serves a work item) followed by the task. Nothing else is
 * added; the pack names its own sections and labels claims as claims.
 */
export function promptWithContext(task: string, contextPack?: { text?: unknown }): string {
  return typeof contextPack?.text === "string" && contextPack.text.length > 0 ? `${contextPack.text}\n\n# Task\n${task}` : task;
}

export interface AgentExecutionInput {
  engine: EngineAdapter;
  attemptId: string;
  jobFence: number;
  leaseId: string;
  runnerId: string;
  runnerEpoch?: number;
  organizationId: string;
  workspaceId: string;
  jobId: string;
  configDigest: string;
  sourceRevision?: string;
  worktreeId?: string;
  instructions?: string;
  task: string;
  modelId?: string | undefined;
  timeoutMs: number;
  cleanupTimeoutMs?: number;
  maxTokens?: number;
  maxMicroUsd?: number;
  maxTurns?: number;
  /**
   * The violations of the step's output contract found in a decoded reply (empty when it conforms). A reply that parses but breaks the
   * contract gets the one corrective session too, told exactly which violations to fix, instead of failing the whole step blind.
   */
  outputCheck?: ((output: JsonValue) => readonly string[]) | undefined;
  allowedTools?: readonly ReleaseRef[];
  executeTool?: (proposal: { proposalId: string; tool: ReleaseRef; input: JsonValue; target: { targetId: string; environmentId: string; preconditionDigest: string }; inputDigest: string }) => Promise<EngineToolExecutionResult>;
  /**
   * Called once the engine session exists: live controls (steer) bind to this
   * handle. Steering is feature-gated on the adapter's probe features.
   */
  onSession?: (handle: { sessionId: string; features: readonly string[]; steer: (messageId: string, message: string) => Promise<void> }) => void;
  emit: (kind: string, payload: unknown) => Promise<void>;
  signal: AbortSignal;
}

export interface AgentExecutionResult {
  ok: boolean;
  output: JsonValue;
  outputText: string;
  cleanupConfirmed?: boolean;
}

function decodedOutput(text: string): JsonValue {
  return decodeModelJson(text)?.value ?? text.trim();
}

/** A reply that tried to be a JSON object but cannot be read as one: worth one corrective try. */
function brokenJson(text: string, output: JsonValue): boolean {
  if (typeof output !== "string") return false;
  const head = text.trimStart();
  return (head.startsWith("{") || head.slice(0, 20).toLowerCase().startsWith("```json") || head.startsWith("```")) && head.slice(0, 200).includes("{");
}

/** The Governor redacts and keeps at most 500 characters of an attempt's error; the runner never sends more than that. */
const ERROR_CHARS = 500;
const CORRECTION_CHARS = 30_000;
function correctiveTask(previous: string): string {
  return `Your previous reply was meant to be one JSON object but it is not valid JSON, so it could not be used. Reply again with only the corrected JSON object: the same content, valid JSON, with every double quote and backslash inside a string escaped, and no text, code fence or comment around it.\n\nYour previous reply:\n${previous.trim().slice(0, CORRECTION_CHARS)}`;
}

function violationTask(previous: string, violations: readonly string[]): string {
  const listed = violations.slice(0, 8).map((violation) => `- ${violation.slice(0, 300)}`).join("\n");
  return `Your previous reply is valid JSON but does not meet the required output contract, so it could not be used. Fix exactly these problems and change nothing else:\n${listed}\n\nReply again with only the complete corrected JSON object, with no text, code fence or comment around it.\n\nYour previous reply:\n${previous.trim().slice(0, CORRECTION_CHARS)}`;
}

async function runAgentSession(input: AgentExecutionInput): Promise<AgentExecutionResult> {
  const { engine } = input;
  const deadline = new AbortController();
  // A change an agent proposes is held by the Governor and made after the decision (ADR 0028): nothing here waits for a person.
  const timer = setTimeout(() => deadline.abort(new Error("agent execution deadline exceeded")), Math.max(1, input.timeoutMs));
  const signal = AbortSignal.any([input.signal, deadline.signal]);
  const bounded = <T>(operation: Promise<T>): Promise<T> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("agent execution aborted"));
      signal.addEventListener("abort", abort, { once: true });
      void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };
  const instructions = input.instructions ?? "";
  const instructionsBytes = new TextEncoder().encode(instructions);
  const taskBytes = new TextEncoder().encode(input.task);
  let sessionId = "";
  let startPending = false;
  let outputText = "";
  let terminalReason = "";
  let terminalConfirmed = false;
  let terminalOutput: { digest: string; bytes: number } | undefined;
  let engineError = false;
  let engineDetail = "";
  let tokensReported = false;
  const cleanup = async (operation: () => Promise<unknown>): Promise<boolean> => {
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation).then(() => true, () => false),
        new Promise<boolean>((resolve) => { cleanupTimer = setTimeout(() => resolve(false), input.cleanupTimeoutMs ?? 2000); }),
      ]);
    } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
  };
  const execute = async (): Promise<AgentExecutionResult> => {
  try {
  const probe = await bounded(engine.probe());
  if (!probe.features.includes("sessions")) {
    return { ok: false, output: { error: `${engine.id} is unavailable or its model is unreachable` }, outputText: "" };
  }
  const spec: EngineSessionSpec = {
    contractVersion: "brain.engine/v1",
    organizationId: input.organizationId, workspaceId: input.workspaceId,
    dispatchId: input.jobId, jobId: input.jobId, attemptId: input.attemptId,
    runnerId: input.runnerId, runnerEpoch: input.runnerEpoch ?? 1, leaseId: input.leaseId, jobFence: input.jobFence,
    engine: probe, modelId: input.modelId ?? engine.defaultModelId ?? "fixture",
    instructions, instructionsDigest: sha256Digest(instructionsBytes), task: input.task,
    sourceRevision: input.sourceRevision ?? input.configDigest, worktreeId: input.worktreeId ?? `read-only:${input.workspaceId}`,
    configDigest: input.configDigest, allowedTools: input.allowedTools ?? [],
    context: {
      artifactId: `ctx-${input.attemptId}`, digest: sha256Digest(taskBytes),
      bytes: taskBytes.length, mediaType: "text/plain", classification: "internal",
    },
    limits: {
      timeoutMs: input.timeoutMs, maxTokens: input.maxTokens ?? 100_000,
      maxMicroUsd: input.maxMicroUsd ?? 0, maxTurns: input.maxTurns ?? 10,
    },
  };
    startPending = true;
    const pendingStart = engine.start(spec, signal);
    // A non-cooperative adapter may finish starting after the deadline.
    void pendingStart.then(async (started) => {
      if (signal.aborted && !sessionId) {
        await cleanup(() => engine.cancel(started.sessionId, "execution expired during start"));
        await cleanup(() => engine.dispose(started.sessionId));
      }
    }, () => undefined);
    const started = await bounded(pendingStart);
    sessionId = started.sessionId;
    startPending = false;
    input.onSession?.({
      sessionId,
      features: probe.features,
      steer: (messageId, message) => {
        if (!engine.steer) return Promise.reject(Object.assign(new Error(`${engine.id} does not support steering`), { code: "UNSUPPORTED_CAPABILITY" }));
        return engine.steer(sessionId, messageId, message);
      },
    });
    const events = engine.events(sessionId, 0, signal)[Symbol.asyncIterator]();
    for (;;) {
      const next = await bounded(events.next());
      if (next.done) break;
      const event = next.value;
      await bounded(input.emit("engine", event as unknown as JsonValue));
      if (event.kind === "usage") {
        const reported = totalsOf(event.payload as unknown as Record<string, unknown>);
        if (reported.inputTokens + reported.outputTokens + reported.cachedInputTokens > 0) tokensReported = true;
      }
      if (event.kind === "tool.proposed") {
        if (!input.executeTool || !engine.toolResult) throw new Error("Agent proposed a tool without a governed broker");
        const result = await bounded(input.executeTool(event.payload));
        await bounded(engine.toolResult(sessionId, result));
      }
      if (event.kind === "error") { engineError = true; engineDetail ||= event.payload.error.detail.replace(/\s+/gu, " ").trim(); }
      // Only what the model says as its answer counts: narration while it still calls tools, and engine notes, are on the diagnostic channel.
      if (event.kind === "text" && event.payload.channel !== "diagnostic") outputText += event.payload.text;
      if (event.kind === "session.stopped") {
        terminalReason = event.payload.reason;
        terminalConfirmed = event.payload.terminationConfirmed;
        terminalOutput = event.payload.output;
        break;
      }
    }
    if (signal.aborted) {
      return { ok: false, output: { error: "agent execution aborted; outcome unknown" }, outputText };
    }
    if (engineError || !terminalConfirmed || terminalReason !== "completed") {
      // The engine said why (its error event); a bare "agent ended with error" tells nobody what to change.
      const ended = terminalReason ? `agent ended with ${terminalReason}` : "agent event stream ended without a terminal result";
      return { ok: false, output: { error: engineDetail ? `${ended}: ${engineDetail}`.slice(0, ERROR_CHARS) : ended }, outputText };
    }
    if (!outputText.trim()) return { ok: false, output: { error: "agent completed without output" }, outputText };
    const bytes = new TextEncoder().encode(outputText);
    if (!terminalOutput || terminalOutput.digest !== sha256Digest(bytes) || terminalOutput.bytes !== bytes.length) {
      return { ok: false, output: { error: "terminal output digest does not match the captured output" }, outputText };
    }
    return { ok: true, output: decodedOutput(outputText), outputText };
  } catch (e) {
    return { ok: false, output: { error: (e instanceof Error ? e.message : "engine execution failed").slice(0, ERROR_CHARS) }, outputText };
  }
  };
  const result = await execute();
  clearTimeout(timer);
  // An endpoint that reports no usage must not leave the meter empty: charge a flagged estimate of 4 bytes per token.
  if (sessionId && !tokensReported) {
    const estimate = estimatedUsage(input.attemptId, sessionId, instructionsBytes.length + taskBytes.length, new TextEncoder().encode(outputText).length);
    await Promise.resolve(input.emit("engine", estimate as unknown as JsonValue)).catch(() => undefined);
  }
  let cleanupConfirmed = !sessionId && !startPending;
  if (sessionId) {
    let terminationConfirmed = terminalConfirmed;
    if (!terminationConfirmed) {
      const cancelled = await cleanup(async () => {
        const cancellation = await engine.cancel(sessionId, "execution ended without confirmed termination");
        terminationConfirmed = cancellation.terminationConfirmed;
      });
      terminationConfirmed = cancelled && terminationConfirmed;
    }
    const disposed = await cleanup(() => engine.dispose(sessionId));
    cleanupConfirmed = terminationConfirmed && disposed;
  }
  return { ...result, ok: result.ok && cleanupConfirmed, cleanupConfirmed };
}

type UsageTotals = { inputTokens: number; outputTokens: number; cachedInputTokens: number; microUsd: number; estimated: boolean };
const totalsOf = (payload: Record<string, unknown>): UsageTotals => {
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  return { inputTokens: n(payload["inputTokens"]), outputTokens: n(payload["outputTokens"]), cachedInputTokens: n(payload["cachedInputTokens"]), microUsd: n(payload["microUsd"]), estimated: payload["estimated"] === true };
};

/** Tokens at 4 bytes each, rounded up; a model that wrote something is charged at least one output token. */
const tokensOfBytes = (bytes: number): number => Math.ceil(bytes / 4);
function estimatedUsage(attemptId: string, sessionId: string, promptBytes: number, outputBytes: number): Record<string, unknown> {
  return {
    contractVersion: "brain.engine-event/v1", eventId: `usage-estimate-${attemptId}`, sessionId, attemptId, sequence: 1_000_000,
    occurredAt: new Date().toISOString(), kind: "usage",
    payload: { usageId: `usage-estimate-${attemptId}`, inputTokens: tokensOfBytes(promptBytes), outputTokens: tokensOfBytes(outputBytes), cachedInputTokens: 0, microUsd: 0, accounting: "final-total", estimated: true },
  };
}

/**
 * Runs the agent step. Strings are repaired when decoding (see `decodeModelJson`); a reply that is still not valid JSON gets one
 * corrective second session that sees its own reply and the parse problem. Both sessions are charged: an engine that reports a final
 * total per session has the first session's total added to the second's, so "the last total wins" still counts everything.
 */
export async function runAgentExecution(input: AgentExecutionInput): Promise<AgentExecutionResult> {
  let first: UsageTotals | undefined;
  const first$ = await runAgentSession({
    ...input,
    emit: async (kind, payload) => {
      const event = payload as { kind?: string; payload?: Record<string, unknown> };
      if (kind === "engine" && event.kind === "usage" && event.payload?.["accounting"] === "final-total") first = totalsOf(event.payload);
      await input.emit(kind, payload);
    },
  });
  if (!first$.ok || input.signal.aborted) return first$;
  let violations: readonly string[] = [];
  let corrective: string | undefined;
  if (brokenJson(first$.outputText, first$.output)) corrective = correctiveTask(first$.outputText);
  else if (input.outputCheck && first$.output !== null && typeof first$.output === "object") {
    violations = input.outputCheck(first$.output);
    if (violations.length > 0) corrective = violationTask(first$.outputText, violations);
  }
  if (!corrective) return first$;
  const carried = first;
  // The correction is part of the same allowance: with little of it left the first reply stands (and fails validation as before), and otherwise
  // the correction gets only what is left, so a corrected attempt never costs twice what the agent may spend.
  const used = carried ? carried.inputTokens + carried.outputTokens + carried.cachedInputTokens : 0;
  const allowance = input.maxTokens !== undefined && input.maxTokens > 0 ? input.maxTokens : undefined;
  if (allowance !== undefined && used > allowance * 0.8) return first$;
  const second = await runAgentSession({
    ...input,
    ...(allowance !== undefined ? { maxTokens: allowance - used } : {}),
    task: corrective,
    emit: async (kind, payload) => {
      const event = payload as { kind?: string; payload?: Record<string, unknown> };
      if (carried && kind === "engine" && event.kind === "usage" && event.payload?.["accounting"] === "final-total") {
        const now = totalsOf(event.payload);
        await input.emit(kind, { ...event, payload: { ...event.payload, usageId: `${String(event.payload["usageId"] ?? "usage")}-corrected`,
          inputTokens: carried.inputTokens + now.inputTokens, outputTokens: carried.outputTokens + now.outputTokens,
          cachedInputTokens: carried.cachedInputTokens + now.cachedInputTokens, microUsd: carried.microUsd + now.microUsd,
          estimated: carried.estimated || event.payload["estimated"] === true } });
        return;
      }
      await input.emit(kind, payload);
    },
  });
  // A correction that is still not JSON, or whose session failed, changes nothing: the first reply stands and fails validation as before.
  if (!second.ok || typeof second.output === "string" || second.output === null) return first$;
  // A correction that breaks the contract in more places than the first reply did is no improvement.
  if (violations.length > 0 && input.outputCheck && input.outputCheck(second.output).length > violations.length) return first$;
  return second;
}
