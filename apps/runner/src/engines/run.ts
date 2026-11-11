import type { EngineAdapter, EngineSessionSpec, EngineToolBinding, EngineToolExecutionResult, JsonValue, ReleaseRef } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { FixtureEngine } from "./fixture";
import { PiEngine } from "./pi";
import { ClaudeEngine } from "./claude";
import { AcpEngine } from "./acp";
import { OpenCodeEngine } from "./opencode";

export function selectEngine(configured: string | undefined, toolBindings: readonly EngineToolBinding[] = []): EngineAdapter | undefined {
  switch (configured) {
    case "fixture": return new FixtureEngine(toolBindings);
    case "pi": return new PiEngine(toolBindings);
    case "claude": return new ClaudeEngine(toolBindings);
    case "acp": return new AcpEngine();
    case "opencode": return new OpenCodeEngine();
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

/**
 * Repairs the two mistakes models most often make inside a JSON string: a backslash that is not a JSON escape (a path, a regular
 * expression, LaTeX: `\d`, `\(`, `\_`) and a raw control character such as a line break. A lone backslash is doubled so it reads as the
 * backslash the model meant; line breaks and tabs become their escapes. Text outside strings is untouched, and so is any valid escape,
 * so repairing text that already parses never changes its meaning.
 */
export function repairJsonStrings(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (!inString) { out += char; if (char === "\"") inString = true; continue; }
    if (char === "\"") { out += char; inString = false; continue; }
    if (char === "\\") {
      const next = text[index + 1];
      if (next !== undefined && "\"\\/bfnrt".includes(next)) { out += char + next; index++; continue; }
      if (next === "u" && /^[0-9a-fA-F]{4}$/u.test(text.slice(index + 2, index + 6))) { out += text.slice(index, index + 6); index += 5; continue; }
      out += "\\\\";
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x20) { out += char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`; continue; }
    out += char;
  }
  return out;
}

function parseJson(text: string): { value: JsonValue } | undefined {
  try { return { value: JSON.parse(text) as JsonValue }; } catch { return undefined; }
}

/** The JSON a model's answer holds, if any: the answer itself, in a code fence, or its one object inside a sentence; as written, else with strings repaired. */
export function decodeModelJson(text: string): { value: JsonValue; repaired: boolean } | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu)?.[1];
  const open = trimmed.indexOf("{"); const close = trimmed.lastIndexOf("}");
  for (const repaired of [false, true]) {
    const prepare = (candidate: string) => (repaired ? repairJsonStrings(candidate) : candidate);
    const whole = parseJson(prepare(fenced ?? trimmed));
    if (whole) return { value: whole.value, repaired };
    // A model sometimes wraps its one JSON object in a sentence; the object between the first "{" and the last "}" is still its answer.
    if (open >= 0 && close > open) {
      const inner = parseJson(prepare(trimmed.slice(open, close + 1)));
      if (inner && inner.value !== null && typeof inner.value === "object" && !Array.isArray(inner.value)) return { value: inner.value, repaired };
    }
  }
  return undefined;
}

function decodedOutput(text: string): JsonValue {
  return decodeModelJson(text)?.value ?? text.trim();
}

/** A reply that tried to be a JSON object but cannot be read as one: worth one corrective try. */
function brokenJson(text: string, output: JsonValue): boolean {
  return typeof output === "string" && /^\s*(?:```(?:json)?\s*)?\{/iu.test(text);
}

const CORRECTION_CHARS = 30_000;
function correctiveTask(previous: string): string {
  return `Your previous reply was meant to be one JSON object but it is not valid JSON, so it could not be used. Reply again with only the corrected JSON object: the same content, valid JSON, with every double quote and backslash inside a string escaped, and no text, code fence or comment around it.\n\nYour previous reply:\n${previous.trim().slice(0, CORRECTION_CHARS)}`;
}

async function runAgentSession(input: AgentExecutionInput): Promise<AgentExecutionResult> {
  const { engine } = input;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("agent execution deadline exceeded")), input.timeoutMs);
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
      if (event.kind === "tool.proposed") {
        if (!input.executeTool || !engine.toolResult) throw new Error("Agent proposed a tool without a governed broker");
        const result = await bounded(input.executeTool(event.payload));
        await bounded(engine.toolResult(sessionId, result));
      }
      if (event.kind === "error") engineError = true;
      if (event.kind === "text") outputText += event.payload.text;
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
      return { ok: false, output: { error: terminalReason ? `agent ended with ${terminalReason}` : "agent event stream ended without a terminal result" }, outputText };
    }
    if (!outputText.trim()) return { ok: false, output: { error: "agent completed without output" }, outputText };
    const bytes = new TextEncoder().encode(outputText);
    if (!terminalOutput || terminalOutput.digest !== sha256Digest(bytes) || terminalOutput.bytes !== bytes.length) {
      return { ok: false, output: { error: "terminal output digest does not match the captured output" }, outputText };
    }
    return { ok: true, output: decodedOutput(outputText), outputText };
  } catch (e) {
    return { ok: false, output: { error: e instanceof Error ? e.message : "engine execution failed" }, outputText };
  }
  };
  const result = await execute();
  clearTimeout(timer);
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

type UsageTotals = { inputTokens: number; outputTokens: number; cachedInputTokens: number; microUsd: number };
const totalsOf = (payload: Record<string, unknown>): UsageTotals => {
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  return { inputTokens: n(payload["inputTokens"]), outputTokens: n(payload["outputTokens"]), cachedInputTokens: n(payload["cachedInputTokens"]), microUsd: n(payload["microUsd"]) };
};

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
  if (!first$.ok || !brokenJson(first$.outputText, first$.output) || input.signal.aborted) return first$;
  const carried = first;
  const second = await runAgentSession({
    ...input,
    task: correctiveTask(first$.outputText),
    emit: async (kind, payload) => {
      const event = payload as { kind?: string; payload?: Record<string, unknown> };
      if (carried && kind === "engine" && event.kind === "usage" && event.payload?.["accounting"] === "final-total") {
        const now = totalsOf(event.payload);
        await input.emit(kind, { ...event, payload: { ...event.payload, usageId: `${String(event.payload["usageId"] ?? "usage")}-corrected`,
          inputTokens: carried.inputTokens + now.inputTokens, outputTokens: carried.outputTokens + now.outputTokens,
          cachedInputTokens: carried.cachedInputTokens + now.cachedInputTokens, microUsd: carried.microUsd + now.microUsd } });
        return;
      }
      await input.emit(kind, payload);
    },
  });
  // A correction that is still not JSON, or whose session failed, changes nothing: the first reply stands and fails validation as before.
  return second.ok && typeof second.output !== "string" ? second : first$;
}
