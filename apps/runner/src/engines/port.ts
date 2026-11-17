import type { Effect, JsonSchema, JsonValue, NativeLevel } from "@brain/contracts";

/**
 * The engine port: what the runner asks of a model harness (pi, claude, an ACP agent, the fixture) for one attempt. It belongs to the
 * runner because nothing else implements or calls it. An adapter normalizes its vendor's types at this boundary; the runner turns what
 * the adapter reports into the attempt events of the protocol.
 */

/** A workspace or Brain-run tool as the engine offers it to the model. `name` is the tool's own name (`git.open-pr`); see `engineToolName` for what the model calls. */
export interface EngineTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly effect: Effect;
}

/** Where the model is: the Governor's gateway (OpenAI-compatible), the attempt's token for it, and the route name sent as the model name. */
export interface EngineModel { readonly baseUrl: string; readonly token: string; readonly name: string }

export interface EngineLimits {
  readonly timeoutMs: number; readonly maxTokens: number; readonly maxMicroUsd: number; readonly maxTurns: number;
  /** The most one model reply may write, thinking included, when the attempt needs more than the engine's default: a check or judge on a reasoning model. */
  readonly maxOutputTokens?: number;
}

export interface EngineSessionSpec {
  readonly attemptId: string;
  /** The agent's prompt. */
  readonly instructions: string;
  readonly task: string;
  readonly model: EngineModel;
  /** The level the engine's own tools are enabled at. The runner passes anything but `none` only to an engine that runs sandboxed, or to the fixture. */
  readonly native: NativeLevel;
  /** The working directory of the engine's own tools, as the engine sees it (`/work` in a sandbox). Absent when the attempt has no working copy the engine may see. */
  readonly workDir?: string;
  /** Where files the agent wants kept go, as the engine sees it (`/out` in a sandbox). */
  readonly outDir: string;
  /** A directory the engine may keep its own files in for this attempt (`/state` in a sandbox). */
  readonly stateDir: string;
  readonly tools: readonly EngineTool[];
  readonly limits: EngineLimits;
}

/** What a session has used so far: totals, never deltas. `turns` counts the model's replies. */
export interface EngineUsage { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens: number; readonly microUsd: number; readonly turns: number }

export type StopReason = "completed" | "cancelled" | "limit" | "timeout" | "error";

export type EngineEvent =
  /** `assistant` text is the answer; `diagnostic` is narration between tool calls and notes of the adapter. */
  | { readonly kind: "text"; readonly channel: "assistant" | "diagnostic"; readonly text: string }
  /** The engine ran one of its own tools. */
  | { readonly kind: "native.call"; readonly callId: string; readonly name: string; readonly input: JsonValue }
  | { readonly kind: "native.result"; readonly callId: string; readonly ok: boolean; readonly output: string }
  /** The model called a workspace or Brain-run tool: the runner carries it out and answers with `toolResult`. */
  | { readonly kind: "tool.request"; readonly callId: string; readonly tool: string; readonly input: JsonValue }
  | ({ readonly kind: "usage" } & EngineUsage)
  /** The last event of a session. `detail` says why for anything but `completed`. */
  | { readonly kind: "stopped"; readonly reason: StopReason; readonly detail?: string };

export interface EngineProbe { readonly id: string; readonly version?: string; readonly ready: boolean }

/** One adapter serves one session at a time; `start` may be called again once a session has stopped (the corrective session of an attempt). */
export interface EngineAdapter {
  readonly id: string;
  /** Whether the engine can start here: its library or binary is present. The model is not asked; it is reached per attempt through the gateway. */
  probe(): Promise<EngineProbe>;
  start(spec: EngineSessionSpec, signal: AbortSignal): Promise<void>;
  /** The events of the session started last, ending after `stopped`. */
  events(signal: AbortSignal): AsyncIterable<EngineEvent>;
  /** The text the model is shown for the tool request `callId`. */
  toolResult(callId: string, text: string): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

/** The native tool names of an engine at each level, in the engine's own spelling. */
export type NativeToolNames = Readonly<Record<NativeLevel, readonly string[]>>;
