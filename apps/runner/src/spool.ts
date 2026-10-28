// Bounded runner-side event spool (E072). A slow or dead consumer can never
// grow runner memory without limit: the spool is capped by both event count
// and serialized bytes. When full, telemetry/text events are refused with a
// backpressure signal (the harness must pause or stop), while durable effect
// events are always retained — they evict the oldest non-effect events
// instead of being dropped.
export interface SpoolEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly payload: unknown;
}

export type SpoolPush = "accepted" | "backpressure" | "duplicate";

const EFFECT_KINDS = new Set(["effect", "tool-effect", "completion", "error"]);

export class EventSpool {
  private readonly events: SpoolEvent[] = [];
  private bytes = 0;
  private lastSequence = 0;
  private droppedTelemetry = 0;

  constructor(
    private readonly maxEvents = 1024,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {}

  push(event: SpoolEvent): SpoolPush {
    if (event.sequence <= this.lastSequence) return "duplicate";
    const size = JSON.stringify(event).length;
    const isEffect = EFFECT_KINDS.has(event.kind);
    while (this.events.length >= this.maxEvents || this.bytes + size > this.maxBytes) {
      if (!isEffect) return "backpressure";
      const victim = this.events.findIndex((e) => !EFFECT_KINDS.has(e.kind));
      if (victim < 0) return "backpressure"; // spool is all-effect: stop rather than drop evidence
      const [evicted] = this.events.splice(victim, 1);
      this.bytes -= JSON.stringify(evicted).length;
      this.droppedTelemetry++;
    }
    this.events.push(event);
    this.bytes += size;
    this.lastSequence = event.sequence;
    return "accepted";
  }

  // Drain up to `limit` events in sequence order after successful delivery.
  drain(limit: number): SpoolEvent[] {
    const out = this.events.splice(0, Math.max(0, limit));
    for (const e of out) this.bytes -= JSON.stringify(e).length;
    return out;
  }

  stats(): { depth: number; bytes: number; lastSequence: number; droppedTelemetry: number } {
    return { depth: this.events.length, bytes: this.bytes, lastSequence: this.lastSequence, droppedTelemetry: this.droppedTelemetry };
  }
}
