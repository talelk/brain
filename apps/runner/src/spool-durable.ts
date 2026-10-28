import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SpoolEvent } from "./spool";

export type SpoolPush = "accepted" | "backpressure" | "duplicate";

/**
 * Disk-backed event spool (T20 durable events). Every accepted event is
 * appended and fsynced before push() returns, so a runner crash or a failed
 * delivery can never silently lose events: unsent records replay from the
 * journal on reload, and the journal is rewritten atomically only after the
 * Governor acknowledges a batch. Bounds mirror the in-memory EventSpool
 * (count + serialized bytes, effect events evict telemetry under pressure).
 */
export class DurableEventSpool {
  private events: SpoolEvent[] = [];
  private bytes = 0;
  private lastSequence = 0;
  private droppedTelemetry = 0;

  private constructor(private readonly path: string, private readonly maxEvents = 1024, private readonly maxBytes = 8 * 1024 * 1024) {}

  /** Loads (or creates) the journal for one attempt, replaying unsent events. */
  static load(path: string, maxEvents = 1024, maxBytes = 8 * 1024 * 1024): DurableEventSpool {
    const spool = new DurableEventSpool(path, maxEvents, maxBytes);
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as SpoolEvent;
          if (typeof event.sequence === "number" && event.sequence > spool.lastSequence) {
            spool.events.push(event);
            spool.bytes += JSON.stringify(event).length;
            spool.lastSequence = event.sequence;
          }
        } catch { /* a torn final line after a crash is skipped, not fatal */ }
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "", { mode: 0o600 });
    }
    return spool;
  }

  push(event: SpoolEvent): SpoolPush {
    if (event.sequence <= this.lastSequence) return "duplicate";
    const size = JSON.stringify(event).length;
    const isEffect = event.kind === "effect" || event.kind === "tool-effect" || event.kind === "completion" || event.kind === "error";
    while (this.events.length >= this.maxEvents || this.bytes + size > this.maxBytes) {
      if (!isEffect) return "backpressure";
      const victim = this.events.findIndex((e) => !(e.kind === "effect" || e.kind === "tool-effect" || e.kind === "completion" || e.kind === "error"));
      if (victim < 0) return "backpressure"; // spool is all-effect: stop rather than drop evidence
      const [evicted] = this.events.splice(victim, 1);
      this.bytes -= JSON.stringify(evicted).length;
      this.droppedTelemetry++;
      this.rewrite();
    }
    this.events.push(event);
    this.bytes += size;
    this.lastSequence = event.sequence;
    // Durability point: the event survives a crash before we report it pushed.
    const fd = openSync(this.path, "a");
    try {
      appendFileSync(fd, `${JSON.stringify(event)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    return "accepted";
  }

  /** The unsent batch, in sequence order. Removal happens only on commit(). */
  peek(limit: number): SpoolEvent[] {
    return this.events.slice(0, Math.max(0, limit));
  }

  /** Drops acknowledged events and rewrites the journal atomically. */
  commit(sequences: readonly number[]): void {
    const acked = new Set(sequences);
    this.events = this.events.filter((e) => !acked.has(e.sequence));
    this.bytes = this.events.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
    this.rewrite();
  }

  discard(): void {
    try { unlinkSync(this.path); } catch { /* already gone */ }
    this.events = [];
    this.bytes = 0;
  }

  stats(): { depth: number; bytes: number; lastSequence: number; droppedTelemetry: number } {
    return { depth: this.events.length, bytes: this.bytes, lastSequence: this.lastSequence, droppedTelemetry: this.droppedTelemetry };
  }

  private rewrite(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, this.events.map((e) => JSON.stringify(e)).join("\n") + (this.events.length ? "\n" : ""), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
