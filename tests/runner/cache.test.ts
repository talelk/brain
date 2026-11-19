import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CACHE_MAX_AGE_MS, sweepCaches, touchMirror } from "../../apps/runner/src/cache";
import { tempDir } from "./git-repo";

/** What the runner keeps between attempts is forgotten after a week (docs/architecture.md, section 8). */
describe("the runner's caches", () => {
  const aged = (path: string, days: number): void => { const at = new Date(Date.now() - days * 86_400_000); utimesSync(path, at, at); };

  it("forgets blobs and mirrors not used for a week, and keeps the rest", () => {
    const state = tempDir("cache");
    mkdirSync(join(state, "blobs"), { recursive: true });
    for (const [name, days] of [["fresh", 1], ["stale", 8]] as const) { writeFileSync(join(state, "blobs", name), name); aged(join(state, "blobs", name), days); }
    for (const [name, days] of [["recent", 2], ["unused", 9]] as const) {
      const mirror = join(state, "repos", "ws1", `${name}.git`);
      mkdirSync(mirror, { recursive: true });
      writeFileSync(join(mirror, "HEAD"), "ref: refs/heads/main\n");
      touchMirror(mirror);
      aged(join(mirror, "brain-used"), days);
    }
    // A mirror made before it was marked is judged by its HEAD.
    const old = join(state, "repos", "ws1", "legacy.git");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "HEAD"), "ref: refs/heads/main\n");
    aged(join(old, "HEAD"), 30);
    expect(sweepCaches(state)).toBe(3);
    expect([existsSync(join(state, "blobs", "fresh")), existsSync(join(state, "blobs", "stale")), existsSync(join(state, "repos", "ws1", "recent.git")), existsSync(join(state, "repos", "ws1", "unused.git")), existsSync(old)]).toEqual([true, false, true, false, false]);
    expect(CACHE_MAX_AGE_MS).toBe(7 * 86_400_000);
    expect(sweepCaches(tempDir("empty"))).toBe(0);
  });
});
