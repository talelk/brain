import type { EngineEvent, EngineSessionSpec, EngineToolBinding, EngineToolExecutionResult } from "@brain/contracts";
import type { HostedRoute } from "./pi";

/**
 * The wire between the runner and an engine running in its per-attempt sandbox (ADR 0065): one JSON object per line, each prefixed so an
 * engine library that prints to stdout cannot be taken for a frame. The requests mirror the EngineAdapter port one to one; the engine itself
 * is unchanged and runs behind them in the container.
 */
export const FRAME_PREFIX = "@brain-engine ";

/** What the host needs before it can build the engine: everything the runner would have given the in-process engine. */
export interface HostInit {
  readonly engine: string;
  readonly toolBindings: readonly EngineToolBinding[];
  readonly route?: HostedRoute;
  /** Settings the engine reads from its environment: addresses and model names, never a credential. */
  readonly env: Readonly<Record<string, string>>;
  /** Credentials the engine reads from its environment. They travel only in this frame, never in the container's argv or environment. */
  readonly secrets: Readonly<Record<string, string>>;
}

export type HostRequest =
  | { readonly id: number; readonly op: "init"; readonly init: HostInit }
  | { readonly id: number; readonly op: "probe" }
  | { readonly id: number; readonly op: "start"; readonly spec: EngineSessionSpec }
  | { readonly id: number; readonly op: "events"; readonly sessionId: string; readonly afterSequence: number }
  | { readonly id: number; readonly op: "abort"; readonly target: number }
  | { readonly id: number; readonly op: "toolResult"; readonly sessionId: string; readonly result: EngineToolExecutionResult }
  | { readonly id: number; readonly op: "cancel"; readonly sessionId: string; readonly reason: string }
  | { readonly id: number; readonly op: "steer"; readonly sessionId: string; readonly messageId: string; readonly message: string }
  | { readonly id: number; readonly op: "checkpoint" | "pause" | "continue" | "dispose"; readonly sessionId: string };

export type HostFrame =
  | { readonly type: "ready" }
  | { readonly type: "result"; readonly id: number; readonly result: unknown }
  | { readonly type: "error"; readonly id: number; readonly message: string; readonly code?: string }
  | { readonly type: "event"; readonly id: number; readonly event: EngineEvent }
  | { readonly type: "end"; readonly id: number };

export const encodeFrame = (value: HostRequest | HostFrame): string => `${FRAME_PREFIX}${JSON.stringify(value)}\n`;

/** The object a line carries, or undefined for anything that is not a frame (library output, blank lines). */
export function decodeFrame<T extends HostRequest | HostFrame>(line: string): T | undefined {
  if (!line.startsWith(FRAME_PREFIX)) return undefined;
  try { return JSON.parse(line.slice(FRAME_PREFIX.length)) as T; } catch { return undefined; }
}
