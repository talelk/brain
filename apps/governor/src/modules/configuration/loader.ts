import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BrainDomainError } from "../../domain/errors";
import { assertConfinedDocPaths, parseRestrictedYaml, type AgentInstruction, type SourceDoc, type ToolScript } from "./compiler";

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

export function loadAgentInstructionsFromDir(root: string, docs: readonly SourceDoc[]): AgentInstruction[] {
  const realRoot = realpathSync(root);
  const instructions: AgentInstruction[] = [];
  for (const doc of docs) {
    const raw = parseRestrictedYaml(doc.text, doc.path);
    if (raw["kind"] !== "Agent") continue;
    const agentId = String((raw["metadata"] as { id?: unknown } | undefined)?.id ?? "");
    const path = String((raw["spec"] as { instructionsPath?: unknown } | undefined)?.instructionsPath ?? "");
    if (!agentId || !path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === ".")) {
      throw new BrainDomainError("INVALID_CONTRACT", `${doc.path}: invalid agent instruction reference`);
    }
    const real = realFile(realRoot, join(realRoot, path));
    instructions.push({ agentId, path, text: readFileSync(real, "utf8") });
  }
  return instructions;
}

export function loadToolScriptsFromDir(root: string, docs: readonly SourceDoc[]): ToolScript[] {
  const realRoot = realpathSync(root);
  const scripts: ToolScript[] = [];
  for (const doc of docs) {
    const raw = parseRestrictedYaml(doc.text, doc.path);
    if (raw["kind"] !== "Tool") continue;
    const toolId = String((raw["metadata"] as { id?: unknown } | undefined)?.id ?? "");
    const entrypoint = String((raw["spec"] as { entrypoint?: unknown } | undefined)?.entrypoint ?? "");
    if (!toolId || !entrypoint) throw new BrainDomainError("INVALID_CONTRACT", `${doc.path}: tool entrypoint is required`);
    const path = `tools/${toolId}/${entrypoint}`;
    const real = realFile(realRoot, join(realRoot, path));
    scripts.push({ toolId, entrypoint, bytesBase64: readFileSync(real).toString("base64") });
  }
  return scripts;
}
