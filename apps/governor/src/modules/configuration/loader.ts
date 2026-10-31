import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BrainDomainError } from "../../domain/errors";
import { assertConfinedDocPaths, type SourceDoc } from "./compiler";

function realFile(root: string, path: string): string {
  const real = realpathSync(path);
  if (real !== root && !real.startsWith(root + sep)) throw new BrainDomainError("INVALID_CONTRACT", `config path escapes root: ${path}`);
  const stat = lstatSync(real);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new BrainDomainError("INVALID_CONTRACT", `config entry is not a regular file: ${path}`);
  return real;
}

export function loadConfigDocsFromDir(root: string): SourceDoc[] {
  const realRoot = realpathSync(root);
  const docs: SourceDoc[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new BrainDomainError("INVALID_CONTRACT", `config symlink forbidden: ${relative(realRoot, full)}`);
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile()) throw new BrainDomainError("INVALID_CONTRACT", `config entry is not a regular file: ${relative(realRoot, full)}`);
      if (!/\.ya?ml$/i.test(entry.name)) continue;
      const real = realFile(realRoot, full);
      docs.push({ path: relative(realRoot, real).split(sep).join("/"), text: readFileSync(real, "utf8") });
    }
  };
  walk(realRoot);
  docs.sort((a, b) => a.path.localeCompare(b.path));
  assertConfinedDocPaths(docs);
  return docs;
}
