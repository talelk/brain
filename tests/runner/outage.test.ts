import { describe, expect, it } from "vitest";
import { Outage } from "../../apps/runner/src/runner";

describe("a Governor that cannot be reached", () => {
  it("is told once with its cause and attempt, backs off, and ends with one reconnected line", () => {
    const lines: string[] = [];
    let now = 0;
    const outage = new Outage("http://governor:3100", () => now, (line) => lines.push(line));
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
    const waits = [1, 2, 3, 4, 5, 6].map(() => outage.failed("attempt", refused, "a_1"));
    now = 42_000;
    outage.ok();
    outage.ok();
    expect(lines).toEqual(["runner attempt failed: ECONNREFUSED at http://governor:3100 (attempt a_1); retrying with backoff", "runner reconnected after 42 s"]);
    expect(waits).toEqual([3000, 6000, 12_000, 24_000, 30_000, 30_000]);
  });
});
