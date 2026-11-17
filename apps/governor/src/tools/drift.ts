import type { JsonValue, SnapshotManifest } from "@brain/contracts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Gov } from "../dispatch";
import { platformWorkspace } from "../workspace/platform";
import { workspaceDir, manifestOf } from "../workspace/store";

/**
 * `platform.tool-drift` (docs/architecture.md section 7): the tools, agents and Plays that workspaces hold in their own folders, compared by name with the
 * pack sources of the platform workspace (`packs/<pack>/`). Read from the folders as they are, deterministic, and cut to 30 entries.
 */
const MAX_ENTRIES = 30;
const textOf = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

interface Item { readonly kind: "tool" | "agent" | "play"; readonly name: string; readonly paths: readonly string[]; readonly hasTest: boolean }

/** The files each thing of a snapshot is made of, when the workspace's own folder supplies them. */
function itemsOf(manifest: SnapshotManifest): Item[] {
  const items: Item[] = [];
  for (const [name, tool] of Object.entries(manifest.tools)) {
    // A tool with no script (Brain-run, host command) is not compared.
    if (tool.source !== "workspace" || !tool.files.some((file) => file.path === "run.sh")) continue;
    items.push({ kind: "tool", name, paths: ["tool.toml", ...tool.files.map((file) => file.path)].map((path) => `tools/${name}/${path}`), hasTest: tool.files.some((file) => file.path === "test.sh") });
  }
  for (const [name, agent] of Object.entries(manifest.agents)) if (agent.source === "workspace") items.push({ kind: "agent", name, paths: [`agents/${name}/agent.toml`, `agents/${name}/prompt.md`], hasTest: false });
  for (const [name, play] of Object.entries(manifest.plays)) if (play.source === "workspace") items.push({ kind: "play", name, paths: [`plays/${name}.toml`], hasTest: false });
  return items;
}

export function driftOf(gov: Gov): { readonly entries: JsonValue[]; readonly workspaces: string[] } {
  const platform = platformWorkspace(gov);
  if (!platform) return { entries: [], workspaces: [] };
  const platformDir = workspaceDir(gov, platform.slug);
  const packs = existsSync(join(platformDir, "packs")) ? readdirSync(join(platformDir, "packs"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
  /** The platform's copy of a path: the first pack that has it. */
  const inPacks = (path: string): { pack: string; text: string } | undefined => {
    for (const pack of packs) {
      const text = textOf(join(platformDir, "packs", pack, path));
      if (text !== undefined) return { pack, text };
    }
    return undefined;
  };
  const grouped = new Map<string, { kind: Item["kind"]; name: string; status: "differs" | "new"; pack: string | null; workspaces: string[]; files: Array<{ path: string; workspace: string }>; hasTest: boolean }>();
  const involved = new Set<string>();
  for (const row of gov.db.prepare("SELECT id, slug, active_snapshot AS snapshot FROM workspaces WHERE id != ? AND status='active' AND active_snapshot != '' ORDER BY slug").all(platform.id) as Array<{ id: string; slug: string; snapshot: string }>) {
    const dir = workspaceDir(gov, row.slug);
    for (const item of itemsOf(manifestOf(gov, row.snapshot as never))) {
      const own = item.paths.map((path) => ({ path, text: textOf(join(dir, path)) }));
      if (own.some((file) => file.text === undefined)) continue;
      const theirs = item.paths.map((path) => inPacks(path));
      const known = theirs.find((found) => found !== undefined);
      const status = known === undefined ? "new" : own.some((file, at) => file.text !== theirs[at]?.text) ? "differs" : undefined;
      if (status === undefined) continue;
      const key = `${item.kind}\n${item.name}\n${own.map((file) => file.text).join("\0")}`;
      const entry = grouped.get(key) ?? { kind: item.kind, name: item.name, status, pack: known?.pack ?? null, workspaces: [], files: item.paths.map((path) => ({ path, workspace: row.slug })), hasTest: item.hasTest };
      entry.workspaces.push(row.slug);
      grouped.set(key, entry);
      involved.add(row.slug);
    }
  }
  const entries = [...grouped.values()].sort((a, b) => b.workspaces.length - a.workspaces.length || `${a.kind}${a.name}`.localeCompare(`${b.kind}${b.name}`)).slice(0, MAX_ENTRIES);
  return { entries: entries as unknown as JsonValue[], workspaces: [...involved] };
}

