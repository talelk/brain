import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The version of an installed dependency, read from the package that was resolved: what an engine really runs. Absent when the package cannot
 * be resolved or states no version, so an engine reports no version rather than one written into this file.
 */
export function installedVersion(packageName: string): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve(packageName)));
    for (let parent = dirname(dir); ; dir = parent, parent = dirname(dir)) {
      const file = join(dir, "package.json");
      if (existsSync(file)) {
        const manifest = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
        if (manifest.name === packageName) return manifest.version && manifest.version.length <= 64 ? manifest.version : undefined;
      }
      if (parent === dir) return undefined;
    }
  } catch {
    return undefined;
  }
}
