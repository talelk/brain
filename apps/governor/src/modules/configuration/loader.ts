import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BrainDomainError } from "../../domain/errors";
import { assertConfinedDocPaths, type SourceDoc } from "./compiler";

// Confined config loader: only regular YAML files under the root are read.
// Symlinks (file or directory) are rejected outright, never followed, so a
// planted link cannot make the compiler read host files outside the root.
export function loadConfigDocsFromDir(root: string): SourceDoc[] {
  const realRoot = realpathSync(root);
  const docs: SourceDoc[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new BrainDomainError("INVALID_CONTRACT", `config symlink forbidden: ${relative(realRoot, full)}`);
      }
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile()) throw new BrainDomainError("INVALID_CONTRACT", `config entry is not a regular file: ${relative(realRoot, full)}`);
      if (!/\.ya?ml$/i.test(entry.name)) continue;
      const real = realpathSync(full);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new BrainDomainError("INVALID_CONTRACT", `config path escapes root: ${entry.name}`);
      }
      docs.push({ path: relative(realRoot, real).split(sep).join("/"), text: readFileSync(real, "utf8") });
    }
  };
  walk(realRoot);
  docs.sort((a, b) => a.path.localeCompare(b.path));
  assertConfinedDocPaths(docs);
  return docs;
}
