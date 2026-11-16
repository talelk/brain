import { isSlug, isToolName, PackFile, type PackSummary } from "@brain/contracts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";

/** The files of a folder: path (with `/`) to bytes. */
export type Files = Map<string, Uint8Array>;

/** What a path of a workspace folder (or of a pack) is. Undefined for a file Brain does not read. */
export type FileKind =
  | { readonly kind: "brain" }
  | { readonly kind: "agent"; readonly name: string; readonly file: "agent.toml" | "prompt.md" }
  | { readonly kind: "tool"; readonly name: string; readonly file: string }
  | { readonly kind: "play"; readonly name: string }
  | { readonly kind: "memory"; readonly name: string };
export function classifyPath(path: string): FileKind | undefined {
  const parts = path.split("/");
  const [top, second, ...rest] = parts;
  if (parts.some((part) => part === "" || part === "." || part === "..") || second === undefined) return path === "brain.toml" ? { kind: "brain" } : undefined;
  if (top === "agents" && isSlug(second) && rest.length === 1 && (rest[0] === "agent.toml" || rest[0] === "prompt.md")) return { kind: "agent", name: second, file: rest[0] };
  if (top === "tools" && isToolName(second) && rest.length > 0) return { kind: "tool", name: second, file: rest.join("/") };
  if (top === "plays" && rest.length === 0 && second.endsWith(".toml") && isSlug(second.slice(0, -5))) return { kind: "play", name: second.slice(0, -5) };
  if (top === "memory" && rest.length === 0 && second.endsWith(".md") && isSlug(second.slice(0, -3))) return { kind: "memory", name: second.slice(0, -3) };
  return undefined;
}

/** Every file under `<packs>/<name>`, or undefined when there is no such pack. */
export function readPack(packsDir: string, name: string): Files | undefined {
  const root = join(packsDir, name);
  if (!isSlug(name) || !existsSync(join(root, "pack.toml"))) return undefined;
  const files: Files = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(root, path), new Uint8Array(readFileSync(path)));
  }
  return files;
}

/** What each shipped pack holds, for choosing packs. A pack whose files do not parse is listed with what could be read. */
export function listPacks(packsDir: string): PackSummary[] {
  if (!existsSync(packsDir)) return [];
  const packs: PackSummary[] = [];
  const toml = (bytes: Uint8Array | undefined): Record<string, unknown> => {
    try { return bytes ? parseToml(new TextDecoder().decode(bytes)) : {}; } catch { return {}; }
  };
  const words = (value: unknown): string => (typeof value === "string" ? value : "");
  for (const name of readdirSync(packsDir).sort()) {
    const files = readPack(packsDir, name);
    const pack = PackFile.safeParse(toml(files?.get("pack.toml")));
    if (!files || !pack.success) continue;
    const summary = { name, description: pack.data.description, requires: pack.data.requires, agents: [] as PackSummary["agents"][number][], tools: [] as PackSummary["tools"][number][], plays: [] as PackSummary["plays"][number][] };
    for (const path of [...files.keys()].sort()) {
      const kind = classifyPath(path);
      const read = toml(files.get(path));
      if (kind?.kind === "agent" && kind.file === "agent.toml") summary.agents.push({ name: kind.name, description: words(read["description"]) });
      else if (kind?.kind === "tool" && kind.file === "tool.toml") summary.tools.push({ name: kind.name, description: words(read["description"]), effect: read["effect"] === "write" || read["effect"] === "privileged" ? read["effect"] : "read" });
      else if (kind?.kind === "play") summary.plays.push({ name: kind.name, title: words(read["title"]), description: words(read["description"]) });
    }
    packs.push(summary);
  }
  return packs;
}
