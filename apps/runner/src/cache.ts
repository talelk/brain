import { existsSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the runner keeps between attempts is a cache, and a cache is forgotten after a week (docs/architecture.md, section 8): the files of
 * snapshots under `blobs/` and the project mirrors under `repos/<workspace>/`, each by the last time it was used. Both are fetched again when
 * they are missing. Nothing that an attempt is using is removed: the sweep runs only while the runner has no attempt.
 */
export const CACHE_MAX_AGE_MS = 7 * 86_400_000;
const USED = "brain-used";

/** Notes that a mirror was used now. */
export function touchMirror(mirror: string): void {
  const marker = join(mirror, USED);
  if (existsSync(marker)) utimesSync(marker, new Date(), new Date());
  else writeFileSync(marker, "");
}

/** Removes the cached blobs and mirrors not used for a week; returns how many. */
export function sweepCaches(stateDir: string, now = Date.now()): number {
  let removed = 0;
  const old = (path: string): boolean => now - statSync(path).mtimeMs > CACHE_MAX_AGE_MS;
  const blobs = join(stateDir, "blobs");
  for (const name of existsSync(blobs) ? readdirSync(blobs) : []) {
    if (old(join(blobs, name))) { rmSync(join(blobs, name), { force: true }); removed += 1; }
  }
  const repos = join(stateDir, "repos");
  for (const workspace of existsSync(repos) ? readdirSync(repos) : []) {
    for (const name of readdirSync(join(repos, workspace))) {
      const mirror = join(repos, workspace, name);
      const marker = join(mirror, USED);
      // A mirror made before it was marked is judged by its HEAD.
      if (old(existsSync(marker) ? marker : join(mirror, "HEAD"))) { rmSync(mirror, { recursive: true, force: true }); removed += 1; }
    }
  }
  return removed;
}
