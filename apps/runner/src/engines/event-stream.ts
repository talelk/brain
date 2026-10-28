import type { EngineEvent } from "@brain/contracts";

export class EngineEventStream {
  private values: EngineEvent[] = [];
  private closed = false;
  private readonly waiters = new Set<() => void>();

  push(event: EngineEvent): void {
    if (this.closed) return;
    this.values.push(event);
    this.wake();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  private wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const ready = () => {
        signal.removeEventListener("abort", ready);
        this.waiters.delete(ready);
        resolve();
      };
      this.waiters.add(ready);
      signal.addEventListener("abort", ready, { once: true });
    });
  }

  async *after(after: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    let index = after;
    for (;;) {
      while (index < this.values.length) {
        const event = this.values[index];
        index += 1;
        if (event && event.sequence > after) yield event;
      }
      if (this.closed || signal.aborted) return;
      await this.wait(signal);
    }
  }
}
