import type { AttemptEvent, AttemptEventBody, EventsResponse } from "@brain/contracts";

/**
 * The events of one attempt on their way to the Governor: numbered in order, sent in batches, sent again after a failed delivery, and
 * bounded. A slow or unreachable Governor can never grow the runner's memory without limit: when the spool is full the oldest text is
 * given up first, and tool calls, native calls, usage and status are kept. The spool lives in memory only: an attempt whose runner dies
 * is given a new fence, and events of the old fence would be refused.
 */
const MAX_EVENTS = 2048;
const MAX_BYTES = 8 * 1024 * 1024;
const BATCH_EVENTS = 128;
const BATCH_BYTES = 512 * 1024;
/** One event never weighs more than this: a longer text or output is cut, and says so. */
const MAX_EVENT_CHARS = 256 * 1024;

function bounded(body: AttemptEventBody): AttemptEventBody {
  if (body.kind === "text" && body.text.length > MAX_EVENT_CHARS) return { ...body, text: `${body.text.slice(0, MAX_EVENT_CHARS)}\n[cut: ${body.text.length} characters]` };
  if (body.kind === "native.result" && body.output.length > MAX_EVENT_CHARS) return { ...body, output: `${body.output.slice(0, MAX_EVENT_CHARS)}\n[cut: ${body.output.length} characters]` };
  if (body.kind === "tool.result" || body.kind === "tool.call" || body.kind === "native.call") {
    const value = body.kind === "tool.result" ? body.output : body.input;
    const text = JSON.stringify(value) ?? "null";
    if (text.length > MAX_EVENT_CHARS) {
      const cut = { cut: true, characters: text.length, start: text.slice(0, MAX_EVENT_CHARS) };
      return body.kind === "tool.result" ? { ...body, output: cut } : { ...body, input: cut };
    }
  }
  return body;
}

export class EventSpool {
  private pending: Array<{ event: AttemptEvent; bytes: number }> = [];
  private bytes = 0;
  private sequence = 0;
  private sending: Promise<void> | undefined;
  private dead = false;
  /** Text events given up because the spool was full. */
  dropped = 0;

  constructor(private readonly send: (events: readonly AttemptEvent[]) => Promise<EventsResponse>, private readonly now: () => number = Date.now) {}

  push(body: AttemptEventBody): void {
    if (this.dead) return;
    const event = { ...bounded(body), seq: ++this.sequence, at: this.now() } as AttemptEvent;
    const bytes = JSON.stringify(event).length;
    while (this.pending.length >= MAX_EVENTS || this.bytes + bytes > MAX_BYTES) {
      const victim = this.pending.findIndex((entry) => entry.event.kind === "text");
      if (victim < 0) { if (event.kind === "text") { this.dropped += 1; return; } break; }
      this.bytes -= this.pending[victim]!.bytes;
      this.pending.splice(victim, 1);
      this.dropped += 1;
    }
    this.pending.push({ event, bytes });
    this.bytes += bytes;
    void this.flush().catch(() => undefined);
  }

  /** Sends what is pending, one batch at a time and in order. A batch that fails stays first in line. */
  flush(): Promise<void> {
    this.sending ??= (async () => {
      try {
        while (this.pending.length > 0 && !this.dead) {
          const batch: AttemptEvent[] = [];
          let size = 0;
          for (const entry of this.pending) {
            if (batch.length >= BATCH_EVENTS || (batch.length > 0 && size + entry.bytes > BATCH_BYTES)) break;
            batch.push(entry.event);
            size += entry.bytes;
          }
          const { through } = await this.send(batch);
          const acknowledged = Math.max(through, batch[batch.length - 1]!.seq);
          const kept = this.pending.filter((entry) => entry.event.seq > acknowledged);
          this.bytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);
          this.pending = kept;
        }
      } finally { this.sending = undefined; }
    })();
    return this.sending;
  }

  /** Delivers everything before the attempt completes, trying a failed delivery again a few times. Throws the last failure. */
  async drain(pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await this.flush(); if (this.pending.length === 0 || this.dead) return; } catch (error) { failure = error; if (this.dead) return; await pause(200 * (attempt + 1)); }
    }
    if (this.pending.length > 0) throw failure ?? new Error("the attempt's events could not be delivered");
  }

  /** The fence moved: nothing more is sent. */
  discard(): void { this.dead = true; this.pending = []; this.bytes = 0; }
}
