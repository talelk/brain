import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WEB = join(import.meta.dirname, "../../apps/web/src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });
}

describe("one live data store (phase 2)", () => {
  it("no screen owns a refresh timer: only the live bus holds setInterval, and refreshMs is gone", () => {
    const offenders: string[] = [];
    for (const file of sources(WEB)) {
      const rel = relative(WEB, file);
      const text = readFileSync(file, "utf8");
      if (/\brefreshMs\b/u.test(text)) offenders.push(`${rel}: refreshMs`);
      if (rel !== "data/live.ts" && /\bsetInterval\s*\(/u.test(text)) offenders.push(`${rel}: setInterval`);
    }
    expect(offenders).toEqual([]);
  });

  it("only the live bus opens the workspace wake stream", () => {
    const wake = sources(WEB).filter((file) => /wake=1/u.test(readFileSync(file, "utf8"))).map((file) => relative(WEB, file));
    expect(wake).toEqual(["data/live.ts"]);
  });
});

describe("live bus", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
  afterEach(() => { vi.useRealTimers(); });

  it("coalesces a burst of changes into one re-read of every subscriber and keeps a minimum gap", async () => {
    const live = await import("../../apps/web/src/data/live");
    const a = vi.fn(); const b = vi.fn();
    const stopA = live.subscribeLive(a); live.subscribeLive(b);
    live.invalidateLive(); live.invalidateLive(); live.invalidateLive();
    expect(a).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1);
    // A second burst right after is held back to the minimum gap.
    live.invalidateLive();
    await vi.advanceTimersByTimeAsync(400);
    expect(a).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(a).toHaveBeenCalledTimes(2);
    // Refresh now skips the wait; an unsubscribed read hears nothing.
    stopA();
    live.refreshLiveNow();
    expect(a).toHaveBeenCalledTimes(2); expect(b).toHaveBeenCalledTimes(3);
  });

  it("one failing read never stops the others", async () => {
    const live = await import("../../apps/web/src/data/live");
    const ok = vi.fn();
    live.subscribeLive(() => { throw new Error("boom"); }); live.subscribeLive(ok);
    live.refreshLiveNow();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
