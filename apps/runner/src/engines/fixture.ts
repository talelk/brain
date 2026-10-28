import type { EngineAdapter, EngineEvent, EngineSessionSpec } from "@brain/contracts";

// Deterministic fixture engine for conformance tests. Never presented as Pi/Claude.
export class FixtureEngine implements EngineAdapter {
  readonly id = "fixture";
  private seq = 0;
  async probe() {
    return { id: "fixture", version: "1", adapterDigest: `sha256:${"0".repeat(64)}`, features: [] };
  }
  async start(_spec: EngineSessionSpec, _signal: AbortSignal) {
    this.seq = 0;
    return { sessionId: "fixture-session" };
  }
  async *events(sessionId: string, _after: number, _signal: AbortSignal): AsyncIterable<EngineEvent> {
    this.seq += 1;
    yield {
      contractVersion: "brain.engine-event/v1",
      eventId: `evt-${this.seq}`, sessionId, attemptId: "fixture-attempt",
      sequence: this.seq, occurredAt: new Date().toISOString(),
      kind: "text", payload: { text: "fixture complete", channel: "assistant", provisional: true },
    };
  }
  async cancel() { return { terminationConfirmed: true }; }
  async checkpoint() {
    return {
      checkpointId: "fixture-checkpoint", sessionId: "fixture-session",
      artifact: { artifactId: "fixture-art", digest: `sha256:${"0".repeat(64)}`, bytes: 0, mediaType: "application/json", classification: "internal" as const },
      createdAt: new Date().toISOString(),
    } as never;
  }
  async dispose() { /* no-op */ }
}
