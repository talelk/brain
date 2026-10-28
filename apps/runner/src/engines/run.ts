import type { EngineAdapter, EngineSessionSpec, JsonValue } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { FixtureEngine } from "./fixture";
import { PiEngine } from "./pi";
import { ClaudeEngine } from "./claude";

/**
 * Engine selection (T24): the configured adapter runs agent-kind executions
 * with real session events, cancellation and checkpoints. With no engine
 * configured, agent jobs fail explicitly — they are never mis-run through the
 * fixture tool path.
 */
export function selectEngine(configured: string | undefined): EngineAdapter | undefined {
  switch (configured) {
    case "fixture": return new FixtureEngine();
    case "pi": return new PiEngine();
    case "claude": return new ClaudeEngine();
    default: return undefined;
  }
}

export interface AgentExecutionInput {
  engine: EngineAdapter;
  attemptId: string;
  jobFence: number;
  leaseId: string;
  runnerId: string;
  organizationId: string;
  workspaceId: string;
  jobId: string;
  configDigest: string;
  task: string;
  modelId?: string | undefined;
  timeoutMs: number;
  /** Streams each authoritative engine event to the attempt journal. */
  emit: (kind: string, payload: unknown) => Promise<void>;
  signal: AbortSignal;
}

export async function runAgentExecution(input: AgentExecutionInput): Promise<{ ok: boolean; output: JsonValue }> {
  const { engine, signal } = input;
  const probe = await engine.probe();
  const spec: EngineSessionSpec = {
    contractVersion: "brain.engine/v1",
    organizationId: input.organizationId, workspaceId: input.workspaceId,
    dispatchId: input.jobId, jobId: input.jobId, attemptId: input.attemptId,
    runnerId: input.runnerId, runnerEpoch: 0, leaseId: input.leaseId, jobFence: input.jobFence,
    engine: probe, modelId: input.modelId ?? "default",
    sourceRevision: "runner", worktreeId: input.attemptId, configDigest: input.configDigest,
    allowedTools: [], context: {
      artifactId: `ctx-${input.attemptId}`, digest: sha256Digest(new TextEncoder().encode(input.task)),
      bytes: Buffer.byteLength(input.task), mediaType: "text/plain", classification: "internal",
    },
    limits: { timeoutMs: input.timeoutMs, maxTokens: 0, maxMicroUsd: 0, maxTurns: 0 },
  };
  const { sessionId } = await engine.start(spec, signal);
  await input.emit("engine", { phase: "session.started", sessionId, engine: engine.id });
  let output: JsonValue = null;
  let ok = false;
  try {
    for await (const event of engine.events(sessionId, 0, signal)) {
      await input.emit("engine", event as unknown as JsonValue);
      if (event.kind === "session.stopped") {
        const stopped = event as { payload: { reason: string; output?: { digest: string } } };
        ok = stopped.payload.reason === "completed";
        output = { stopped: stopped.payload.reason, outputDigest: stopped.payload.output?.digest ?? null } as unknown as JsonValue;
        break;
      }
      if (event.kind === "artifact" && (event as { payload: { purpose?: string } }).payload.purpose === "output") {
        output = (event as unknown as { payload: { artifact: unknown } }).payload.artifact as unknown as JsonValue;
      }
    }
    if (signal.aborted) {
      await engine.cancel(sessionId, "lease lost or deadline reached").catch(() => undefined);
      return { ok: false, output: { error: "agent execution aborted; outcome unknown" } as unknown as JsonValue };
    }
  } catch (e) {
    await engine.cancel(sessionId, e instanceof Error ? e.message : "engine failure").catch(() => undefined);
    return { ok: false, output: { error: e instanceof Error ? e.message : "engine execution failed" } as unknown as JsonValue };
  }
  return { ok, output };
}
