import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Global setup for every Vitest run: when all workers have finished, remove
 * the disposable brain-test-* data directories this run created, so repeated
 * runs never exhaust the temp volume. Directories from other runs are kept.
 */
export default function setup(): () => void {
  const started = Date.now();
  return () => {
    const root = tmpdir();
    for (const name of readdirSync(root)) {
      if (!name.startsWith("brain-test-")) continue;
      const path = join(root, name);
      try {
        if (statSync(path).ctimeMs >= started) rmSync(path, { recursive: true, force: true });
      } catch { /* already gone */ }
    }
  };
}
