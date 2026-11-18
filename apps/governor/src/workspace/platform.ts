import { BrainError, type PlatformKind, type SnapshotManifest } from "@brain/contracts";
import { parse as parseToml } from "smol-toml";
import type { Gov } from "../dispatch";
import { manifestOf } from "./store";
import type { Files } from "./files";

/**
 * Platform workspaces (docs/model.md): those whose `brain.toml` says `platform = "admin"` or `"read"`. There is at most one `admin`, the only
 * place packs are kept and released; any number are `read`. Which workspaces they are lives only in that file, so the check that keeps the
 * setting safe is made once, where a folder is committed (`commitFolder`), before anything is written.
 */
export interface PlatformWorkspace { readonly id: string; readonly slug: string; readonly kind: PlatformKind }

/** Every platform workspace, from the active snapshots. */
export function platformWorkspaces(gov: Gov): PlatformWorkspace[] {
  return (gov.db.prepare("SELECT id, slug, active_snapshot AS snapshot FROM workspaces WHERE active_snapshot != '' ORDER BY slug").all() as Array<{ id: string; slug: string; snapshot: string }>)
    .flatMap((row) => { const kind = manifestOf(gov, row.snapshot as never).platform; return kind ? [{ id: row.id, slug: row.slug, kind }] : []; });
}

/** The workspace, when it is a platform workspace of either kind. */
export const platformOf = (gov: Gov, workspaceId: string): PlatformWorkspace | undefined => platformWorkspaces(gov).find((one) => one.id === workspaceId);
/** The admin workspace: where packs are kept and released; undefined when there is none. */
export const adminWorkspace = (gov: Gov): PlatformWorkspace | undefined => platformWorkspaces(gov).find((one) => one.kind === "admin");

/**
 * The models a workspace calls: its own `[[model]]` entries, or, when it has none, those of the admin workspace (the one place the
 * Brain's model is defined once). `from` is the workspace whose secrets hold the keys.
 */
export function modelsOf(gov: Gov, workspaceId: string, own: SnapshotManifest): { readonly models: SnapshotManifest["models"]; readonly from: { readonly id: string; readonly slug: string } | null } {
  if (own.models.length > 0) return { models: own.models, from: null };
  const admin = adminWorkspace(gov);
  if (!admin || admin.id === workspaceId) return { models: [], from: null };
  const row = gov.db.prepare("SELECT active_snapshot AS snapshot FROM workspaces WHERE id = ? AND status = 'active'").get(admin.id) as { snapshot: string } | undefined;
  return row ? { models: manifestOf(gov, row.snapshot as never).models, from: { id: admin.id, slug: admin.slug } } : { models: [], from: null };
}

/** What a folder's own `brain.toml` says about `platform`. */
export function platformOfFiles(files: Files): PlatformKind | undefined {
  const bytes = files.get("brain.toml");
  if (!bytes) return undefined;
  try {
    const value = (parseToml(new TextDecoder().decode(bytes)) as { platform?: unknown }).platform;
    return value === "admin" || value === "read" ? value : undefined;
  } catch { return undefined; }
}

/**
 * Refuses a change of the folder `slug` that adds, changes or removes `platform` unless a platform administrator (an instance admin) makes it,
 * and a second `admin` workspace. `before` is the folder as committed (none for a new one), `after` the manifest it would have.
 * True when the change makes the workspace the admin workspace (it is then given the pack sources).
 */
export function guardPlatform(gov: Gov, slug: string, before: Files | undefined, after: SnapshotManifest, instanceAdmin: boolean): boolean {
  const was = before ? platformOfFiles(before) : undefined;
  const will = after.platform;
  if (was === will) return false;
  if (!instanceAdmin) throw new BrainError("FORBIDDEN", "Only a platform administrator can make a workspace a platform workspace, change its kind, or stop it being one");
  if (will === "admin") {
    const other = adminWorkspace(gov);
    if (other && other.slug !== slug) throw new BrainError("CONFLICT", `${other.slug} is already the admin workspace; a Brain has only one. Make this one "read", or change ${other.slug} first`);
  }
  return will === "admin";
}
