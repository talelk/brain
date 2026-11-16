import type { EngineEvent } from "./port";

/** The events of one engine session: pushed by the adapter, read once by the runner, ended by `close`. */
export class EngineEventStream {
  private readonly values: EngineEvent[] = [];
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

  async *read(signal: AbortSignal): AsyncIterable<EngineEvent> {
    let index = 0;
    for (;;) {
      while (index < this.values.length) yield this.values[index++]!;
      if (this.closed || signal.aborted) return;
      await this.wait(signal);
    }
  }
}
