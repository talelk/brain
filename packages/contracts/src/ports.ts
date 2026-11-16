import type { ArtifactRef, Checkpoint, EngineEvent, EngineInfo, EngineSessionSpec, JsonValue, ReleaseRef, Target, ToolReceipt } from "./protocol";

/** Ports with more than one implementation. An implementation normalizes vendor types at its own boundary. */
export interface Clock {
  nowMs(): number;
  monotonicMs(): number;
}
export interface EngineToolBinding {
  release: ReleaseRef;
  inputSchema: Readonly<Record<string, JsonValue>>;
  effectClass: "read" | "write" | "privileged";
  target: Target;
  /** Hosts a network-reading tool may reach, from the tool file; the runner refuses everything else. */
  allowedHosts?: readonly string[];
}
export interface EngineToolExecutionResult {
  proposalId: string;
  invocationId: string;
  receipt: ToolReceipt;
  output: JsonValue;
}
export interface EngineAdapter {
  readonly id: string;
  readonly defaultModelId?: string;
  probe(): Promise<EngineInfo>;
  start(spec: EngineSessionSpec, signal: AbortSignal): Promise<{ sessionId: string }>;
  events(sessionId: string, afterSequence: number, signal: AbortSignal): AsyncIterable<EngineEvent>;
  toolResult?(sessionId: string, result: EngineToolExecutionResult): Promise<void>;
  cancel(sessionId: string, reason: string): Promise<{ terminationConfirmed: boolean }>;
  checkpoint(sessionId: string): Promise<Checkpoint>;
  /** The bytes of the saved conversation a checkpoint just taken names. Offered only by engines whose checkpoint is a warm-start artifact. */
  readCheckpoint?(state: ArtifactRef): Promise<Uint8Array>;
  /** Makes a saved conversation available to the next `start` with `resumeFrom`. Refuses bytes whose digest or size differ from the reference. */
  stageCheckpoint?(state: ArtifactRef, bytes: Uint8Array): Promise<void>;
  steer?(sessionId: string, messageId: string, message: string): Promise<void>;
  /** Holds the session at its next turn boundary and resolves once it is held. Offered only by engines that advertise the "pause" feature. */
  pause?(sessionId: string): Promise<void>;
  /** Releases a held session (or cancels a pause not yet reached); a no-op for a session that is not held. */
  continue?(sessionId: string): Promise<void>;
  dispose(sessionId: string): Promise<void>;
}
