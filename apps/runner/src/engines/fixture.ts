import { readFileSync } from "node:fs";
import { sha256Digest } from "@brain/contracts";
import type { EngineAdapter, EngineEvent, EngineSessionSpec } from "@brain/contracts";
import { EngineEventStream } from "./event-stream";

export class FixtureEngine implements EngineAdapter {
  readonly id = "fixture";
  private seq = 0;
  private sessionId = "";
  private attemptId = "";
  private stream = new EngineEventStream();

  async probe() {
    return { id: "fixture", version: "1", adapterDigest: sha256Digest(new Uint8Array(readFileSync(new URL(import.meta.url)))), features: ["sessions"] };
  }

  private push(spec: EngineSessionSpec, kind: EngineEvent["kind"], payload: EngineEvent["payload"]): void {
    this.seq += 1;
    this.stream.push({
      contractVersion: "brain.engine-event/v1", eventId: `fixture-evt-${this.seq}`,
      sessionId: this.sessionId, attemptId: this.attemptId, sequence: this.seq,
      occurredAt: new Date().toISOString(), kind, payload,
    } as EngineEvent);
  }

  async start(spec: EngineSessionSpec, signal: AbortSignal) {
    this.seq = 0;
    this.stream = new EngineEventStream();
    this.sessionId = `fixture-${spec.attemptId}`;
    this.attemptId = spec.attemptId;
    this.push(spec, "session.started", { engine: await this.probe() });
    void Promise.resolve().then(() => {
      let response: unknown = { text: "fixture complete" };
      try {
        const input = JSON.parse(spec.task) as Record<string, unknown>;
        if (typeof input["situation"] === "string") response = { summary: `Fixture: ${input["situation"]}`, blockers: [], nextActions: ["Inspect diagnostic inputs"] };
        if (typeof input["title"] === "string" && typeof input["body"] === "string") response = { summary: `Fixture: ${input["title"]}`, missingInformation: [], risk: "low", proposedReply: `Fixture draft: ${input["body"]}` };
      } catch { /* Plain-text engine conformance tasks use the default response. */ }
      const text = spec.task.includes("BRAIN_OK") ? "BRAIN_OK" : JSON.stringify(response);
      const bytes = new TextEncoder().encode(text);
      const artifact = {
        artifactId: `fixture-output-${spec.attemptId}`, digest: sha256Digest(bytes), bytes: bytes.length,
        mediaType: "text/plain", classification: "internal" as const,
      };
      this.push(spec, "text", { text, channel: "assistant", provisional: true });
      this.push(spec, "artifact", { artifact, purpose: "output" });
      this.push(spec, "session.stopped", { reason: "completed", terminationConfirmed: true, output: artifact });
      this.stream.close();
    });
    if (signal.aborted) await this.cancel(this.sessionId, "aborted before start");
    return { sessionId: this.sessionId };
  }

  async *events(_sessionId: string, after: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    yield* this.stream.after(after, signal);
  }

  async cancel(_sessionId?: string, _reason?: string) {
    this.stream.close();
    return { terminationConfirmed: true };
  }

  async checkpoint(): Promise<never> {
    throw Object.assign(new Error("Fixture checkpointing is unsupported"), { code: "UNSUPPORTED_CAPABILITY" });
  }

  async dispose(_sessionId?: string) { this.stream.close(); }
}
