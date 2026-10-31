import type { EngineAdapter, EngineSessionSpec, EngineToolBinding, EngineToolExecutionResult, JsonValue, ReleaseRef } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { FixtureEngine } from "./fixture";
import { PiEngine } from "./pi";
import { ClaudeEngine } from "./claude";
import { AcpEngine } from "./acp";
import { OpenCodeEngine } from "./opencode";

export function selectEngine(configured: string | undefined, toolBindings: readonly EngineToolBinding[] = []): EngineAdapter | undefined {
  switch (configured) {
    case "fixture": return new FixtureEngine();
    case "pi": return new PiEngine(toolBindings);
    case "claude": return new ClaudeEngine(toolBindings);
    case "acp": return new AcpEngine();
    case "opencode": return new OpenCodeEngine();
    default: return undefined;
  }
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
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu)?.[1];
  try { return JSON.parse(fenced ?? trimmed) as JsonValue; }
  catch { return trimmed; }
}

export async function runAgentExecution(input: AgentExecutionInput): Promise<AgentExecutionResult> {
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
