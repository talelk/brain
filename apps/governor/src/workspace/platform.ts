import { BrainError, type SnapshotManifest } from "@brain/contracts";
import { parse as parseToml } from "smol-toml";
import type { Gov } from "../dispatch";
import { manifestOf } from "./store";
import type { Files } from "./files";

/**
 * The platform workspace (docs/model.md): the one workspace whose `brain.toml` says `platform = true`. Which workspace it is lives only in
 * that file, so the check that keeps the setting safe is made once, where a folder is committed (`commitFolder`), before anything is written.
 */
export interface PlatformWorkspace { readonly id: string; readonly slug: string }

/** The platform workspace, from the active snapshots; undefined when there is none. */
export function platformWorkspace(gov: Gov): PlatformWorkspace | undefined {
  for (const row of gov.db.prepare("SELECT id, slug, active_snapshot AS snapshot FROM workspaces WHERE active_snapshot != ''").all() as Array<{ id: string; slug: string; snapshot: string }>) {
    if (manifestOf(gov, row.snapshot as never).platform === true) return { id: row.id, slug: row.slug };
  }
  return undefined;
}

/** True when the workspace's active snapshot says it is the platform workspace. */
export const isPlatform = (manifest: Pick<SnapshotManifest, "platform">): boolean => manifest.platform === true;

/** What a folder's own `brain.toml` says about `platform`. */
export function platformOfFiles(files: Files): boolean {
  const bytes = files.get("brain.toml");
  if (!bytes) return false;
  try { return (parseToml(new TextDecoder().decode(bytes)) as { platform?: unknown }).platform === true; } catch { return false; }
}

/**
 * Refuses a change of the folder `slug` that adds, changes or removes `platform` unless an instance admin makes it, and a second platform workspace.
 * `before` is the folder as committed (none for a new one), `after` the manifest it would have. True when the change makes the workspace the platform workspace.
 */
export function guardPlatform(gov: Gov, slug: string, before: Files | undefined, after: SnapshotManifest, instanceAdmin: boolean): boolean {
  const was = before ? platformOfFiles(before) : false;
  const will = isPlatform(after);
  if (was === will) return false;
  if (!instanceAdmin) throw new BrainError("FORBIDDEN", "Only an administrator of this Brain can make a workspace the platform workspace, or stop it being one");
  const other = will ? platformWorkspace(gov) : undefined;
  if (other && other.slug !== slug) throw new BrainError("CONFLICT", `${other.slug} is already the platform workspace; a Brain has only one`);
  return will;
}
