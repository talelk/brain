import type { EngineEvent, EngineProbe, EngineSessionSpec } from "./port";

/**
 * The wire between the runner and an engine running in its attempt's sandbox: one JSON object per line, each prefixed so an engine
 * library that prints to stdout cannot be taken for a frame. The requests mirror the engine port one to one, plus `exec`, which runs a
 * project's setup command in the same sandbox the agent will work in. The gateway token travels in the `start` frame only, never in the
 * container's argv or environment.
 */
const FRAME_PREFIX = "@brain-engine ";

export type HostRequest =
  | { readonly id: number; readonly op: "init"; readonly engine: string }
  | { readonly id: number; readonly op: "probe" | "events" | "cancel" | "dispose" }
  | { readonly id: number; readonly op: "start"; readonly spec: EngineSessionSpec }
  | { readonly id: number; readonly op: "abort"; readonly target: number }
  | { readonly id: number; readonly op: "toolResult"; readonly callId: string; readonly text: string }
  | { readonly id: number; readonly op: "exec"; readonly command: string; readonly cwd: string; readonly timeoutMs: number };

export interface ExecResult { readonly exitCode: number; readonly output: string; readonly timedOut: boolean }

export type HostFrame =
  | { readonly type: "ready" }
  | { readonly type: "result"; readonly id: number; readonly result: EngineProbe | ExecResult | Record<string, never> }
  | { readonly type: "error"; readonly id: number; readonly message: string }
  | { readonly type: "event"; readonly id: number; readonly event: EngineEvent }
  | { readonly type: "end"; readonly id: number };

export const encodeFrame = (value: HostRequest | HostFrame): string => `${FRAME_PREFIX}${JSON.stringify(value)}\n`;

/** The object a line carries, or undefined for anything that is not a frame (library output, blank lines). */
export function decodeFrame<T extends HostRequest | HostFrame>(line: string): T | undefined {
  if (!line.startsWith(FRAME_PREFIX)) return undefined;
  try { return JSON.parse(line.slice(FRAME_PREFIX.length)) as T; } catch { return undefined; }
}
