import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import { sha256Digest } from "@brain/contracts";

/** Collect declared files only. Compilation and authority stay in Governor. */
export function collectRelease(directory: string) {
  const root = realpathSync(directory);
  const documents: { path: string; text: string }[] = [];
  let total = 0;
  const read = (path: string): Buffer => {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`release path escapes root: ${path}`);
    let current = root;
    for (const part of path.split("/")) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error(`release symlink forbidden: ${path}`);
    }
    const real = realpathSync(current);
    const stat = lstatSync(real);
    if (!real.startsWith(root + sep) || !stat.isFile()) throw new Error(`release asset is not confined: ${path}`);
    total += stat.size;
    if (stat.size > 1024 * 1024 || total > 4 * 1024 * 1024) throw new Error("release bundle exceeds upload limits");
    return readFileSync(real);
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`release symlink forbidden: ${entry.name}`);
      if (entry.isDirectory()) walk(full);
      else if (/\.ya?ml$/i.test(entry.name)) {
        const path = relative(root, full).split(sep).join("/");
        documents.push({ path, text: read(path).toString("utf8") });
        if (documents.length > 100) throw new Error("release exceeds 100 documents");
      }
    }
  };
  walk(root);
  documents.sort((a, b) => a.path.localeCompare(b.path));
  const schemas: { path: string; text: string }[] = [];
  const schemaPaths = new Set<string>();
  const scripts: { toolId: string; entrypoint: string; bytesBase64: string }[] = [];
  const instructions: { agentId: string; path: string; text: string }[] = [];
  for (const doc of documents) {
    const parsed = parseDocument(doc.text, { uniqueKeys: true });
    if (parsed.errors.length) throw new Error(`${doc.path}: ${parsed.errors[0]?.message}`);
    const value = parsed.toJS({ maxAliasCount: 0 }) as { kind?: string; metadata?: { id?: string }; spec?: { instructionsPath?: string; entrypoint?: string } };
    const findSchemas = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      for (const [key, val] of Object.entries(node)) {
        if (key.endsWith("SchemaRef") && typeof val === "string" && !schemaPaths.has(val)) {
          schemaPaths.add(val); schemas.push({ path: val, text: read(val).toString("utf8") });
        } else if (val && typeof val === "object") findSchemas(val);
      }
    };
    findSchemas(value);
    if (value.kind === "Agent") {
      const path = value.spec?.instructionsPath ?? "";
      instructions.push({ agentId: value.metadata?.id ?? "", path, text: read(path).toString("utf8") });
    }
    if (value.kind === "Tool") {
      const toolId = value.metadata?.id ?? "";
      const entrypoint = value.spec?.entrypoint ?? "";
      scripts.push({ toolId, entrypoint, bytesBase64: read(`tools/${toolId}/${entrypoint}`).toString("base64") });
    }
  }
  const bundle = { documents, scripts, instructions, schemas };
  return { ...bundle, sourceRevision: sha256Digest(new TextEncoder().encode(JSON.stringify(bundle))) };
}
