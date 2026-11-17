import { BrainError, canonicalJsonBytes, pathProblem, type Actor, type Digest, type JsonValue, type Problem, type SnapshotManifest } from "@brain/contracts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tx, type Db } from "../db";
import type { Gov } from "../dispatch";
import { append, SYSTEM } from "../events";
import { putArtifact, readArtifact } from "../trust/artifacts";
import { classifyPath, releasedDirOf, type Files } from "./files";
import { commitChange, readHead, type Author } from "./git";
import { loadWorkspace, type Loaded } from "./load";
import { seedPacks } from "./packs";
import { guardPlatform } from "./platform";
import { log } from "../log";

/** Workspace folders on disk and their snapshots in the database: validate, commit, activate. */
export interface WorkspaceRow { readonly id: string; readonly slug: string; readonly name: string; readonly description: string; readonly status: "active" | "archived"; readonly snapshotDigest: Digest }

export const workspaceDir = (gov: Gov, slug: string): string => join(gov.dataDir, "workspaces", slug);

export function getWorkspace(db: Db, workspaceId: string): WorkspaceRow {
  const row = db.prepare("SELECT id, slug, name, description, status, active_snapshot AS snapshotDigest FROM workspaces WHERE id=?").get(workspaceId) as WorkspaceRow | undefined;
  if (!row) throw new BrainError("NOT_FOUND", "Workspace not found");
  return row;
}

const manifests = new Map<Digest, SnapshotManifest>();
/** The manifest a snapshot digest names. Work created on a snapshot keeps reading it through this, whatever the workspace becomes. */
export function manifestOf(gov: Gov, digest: Digest): SnapshotManifest {
  let manifest = manifests.get(digest);
  if (!manifest) {
    manifest = JSON.parse(new TextDecoder().decode(readArtifact(gov, digest))) as SnapshotManifest;
    if (manifests.size >= 64) manifests.delete(manifests.keys().next().value as Digest);
    manifests.set(digest, manifest);
  }
  return manifest;
}
export const activeManifest = (gov: Gov, workspaceId: string): SnapshotManifest => manifestOf(gov, getWorkspace(gov.db, workspaceId).snapshotDigest);

/** The folder as it is committed, read with its packs. */
export async function loadFolder(gov: Gov, slug: string): Promise<Loaded & { commit: string }> {
  const head = await readHead(workspaceDir(gov, slug));
  return { ...loadWorkspace(head.files, gov.packsDir, releasedDirOf(gov.dataDir)), commit: head.commit };
}

/** Stores a valid folder's manifest and the bytes it names; the manifest's digest is the snapshot digest. */
function storeSnapshot(gov: Gov, loaded: Loaded & { manifest: SnapshotManifest }): Digest {
  for (const bytes of loaded.blobs.values()) putArtifact(gov, bytes);
  return putArtifact(gov, canonicalJsonBytes(loaded.manifest as unknown as JsonValue));
}

const queues = new Map<string, Promise<unknown>>();
/** One change to a folder at a time. */
function inTurn<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const turn = (queues.get(dir) ?? Promise.resolve()).then(work);
  const settled = turn.catch(() => undefined);
  queues.set(dir, settled);
  void settled.then(() => { if (queues.get(dir) === settled) queues.delete(dir); });
  return turn;
}

export interface FolderChange {
  readonly write: ReadonlyMap<string, Uint8Array>; readonly remove: readonly string[]; readonly message: string; readonly author: Author;
  /** Whether an instance admin makes the change: only then may it add, change or remove `platform` (workspace/platform.ts). */
  readonly instanceAdmin: boolean;
}
/** A committed, valid folder, ready to be made the active snapshot. */
export interface Committed { readonly commit: string; readonly snapshotDigest: Digest; readonly manifest: SnapshotManifest; readonly paths: readonly string[] }

/** The folder as it would be after a change: the files to write (those that differ), or the problems. A folder that would not be valid is refused. */
function applied(head: { readonly files: Files } | undefined, change: Pick<FolderChange, "write" | "remove">, packs: { readonly shipped: string; readonly released: string }): { readonly files: Files; readonly write: Map<string, Uint8Array>; readonly loaded: Loaded & { manifest: SnapshotManifest } } {
  const files: Files = new Map(head?.files);
  const refused: Problem[] = [];
  const write = new Map<string, Uint8Array>();
  for (const [path, bytes] of change.write) {
    if (!classifyPath(path)) refused.push({ path, message: pathProblem(path) ?? "Under agents/, tools/, plays/ and memory/ Brain reads agents/<name>/agent.toml and prompt.md, tools/<name>/<file>, plays/<name>.toml and memory/<name>.md (or memory/<name>.fr.md, .ar.md); this path is none of them" });
    else if ([...files.keys()].some((other) => other.startsWith(`${path}/`) || path.startsWith(`${other}/`))) refused.push({ path, message: "a file and a folder cannot have the same name" });
    const before = files.get(path);
    if (!before || Buffer.compare(before, bytes) !== 0) write.set(path, bytes);
    files.set(path, bytes);
  }
  for (const path of change.remove) if (!files.delete(path)) refused.push({ path, message: "the workspace has no such file" });
  if (refused.length > 0) throw new BrainError("INVALID_INPUT", "The change names files that cannot be written or removed", refused);
  const loaded = loadWorkspace(files, packs.shipped, packs.released);
  if (!loaded.manifest) throw new BrainError("INVALID_WORKSPACE", "The workspace would not be valid, so nothing was changed", loaded.problems);
  return { files, write, loaded: { ...loaded, manifest: loaded.manifest } };
}

/**
 * Validates the folder as it would be after the change; only a valid one is written and committed. An invalid one is refused with the
 * path and message of each problem, and nothing changes. A new folder (no repository yet) is created by its first change.
 */
export function commitFolder(gov: Gov, slug: string, change: FolderChange): Promise<Committed> {
  const dir = workspaceDir(gov, slug);
  return inTurn(dir, async () => {
    const head = existsSync(join(dir, ".git")) ? await readHead(dir) : undefined;
    const packs = { shipped: gov.packsDir, released: releasedDirOf(gov.dataDir) };
    let made = applied(head, change, packs);
    // The commit that makes a workspace the platform workspace also gives it an editable copy of every shipped pack.
    if (guardPlatform(gov, slug, head?.files, made.loaded.manifest, change.instanceAdmin)) {
      const seeds = [...seedPacks(gov)].filter(([path]) => !head?.files.has(path) && !change.write.has(path));
      made = applied(head, { ...change, write: new Map([...seeds, ...change.write]) }, packs);
    }
    const { write, loaded } = made;
    const paths = [...write.keys(), ...change.remove];
    const commit = head && paths.length === 0 ? head.commit : await commitChange(dir, { ...change, write });
    return { commit, snapshotDigest: storeSnapshot(gov, loaded), manifest: loaded.manifest, paths };
  });
}

/** What a change would make of the folder, without writing anything: the files as they are now and the manifest they would give. */
export function checkFolder(gov: Gov, slug: string, change: Pick<FolderChange, "write" | "remove">): Promise<{ readonly before: Files; readonly manifest: SnapshotManifest }> {
  const dir = workspaceDir(gov, slug);
  return inTurn(dir, async () => {
    const head = await readHead(dir);
    return { before: head.files, manifest: applied(head, change, { shipped: gov.packsDir, released: releasedDirOf(gov.dataDir) }).loaded.manifest };
  });
}

/** Makes a committed folder the workspace's active snapshot. Work already created keeps the snapshot it was created with. */
export function activate(gov: Gov, db: Db, workspaceId: string, committed: Committed, actor: Actor, type: "workspace.created" | "workspace.changed"): void {
  const { manifest, snapshotDigest, commit } = committed;
  db.prepare(`INSERT INTO snapshots(workspace_id, digest, commit_sha, created_at_ms) VALUES (?,?,?,?)
    ON CONFLICT(workspace_id, digest) DO UPDATE SET commit_sha=excluded.commit_sha`).run(workspaceId, snapshotDigest, commit, gov.clock.nowMs());
  const before = (db.prepare("SELECT active_snapshot AS digest FROM workspaces WHERE id=?").get(workspaceId) as { digest: string } | undefined)?.digest;
  const wasPublic = before !== undefined && before !== "" && (manifestOf(gov, before as Digest) as { visibility?: string }).visibility === "public";
  db.prepare("UPDATE workspaces SET active_snapshot=?, name=?, description=? WHERE id=?").run(snapshotDigest, manifest.name, manifest.description, workspaceId);
  if (type === "workspace.changed" && wasPublic !== (manifest.visibility === "public")) {
    append(db, { type: "workspace.visibility", workspaceId, subject: `workspace:${workspaceId}`, payload: { visibility: manifest.visibility, commit }, actor });
  }
  for (const hook of gov.onActivate) hook(workspaceId, manifest);
  append(db, { type, workspaceId, subject: `workspace:${workspaceId}`, payload: { commit, snapshotDigest, paths: [...committed.paths] }, actor });
}

export function commitOf(db: Db, workspaceId: string, digest: Digest): string {
  return (db.prepare("SELECT commit_sha FROM snapshots WHERE workspace_id=? AND digest=?").get(workspaceId, digest) as { commit_sha: string }).commit_sha;
}

/**
 * At start: a folder whose committed content (or whose packs) no longer match the active snapshot is activated again if it is valid. This
 * finishes a change that was committed just before a crash and takes in packs that changed with a new version of Brain.
 */
export async function reconcile(gov: Gov): Promise<void> {
  for (const workspace of gov.db.prepare("SELECT id, slug, active_snapshot AS snapshotDigest FROM workspaces WHERE status='active'").all() as Array<Pick<WorkspaceRow, "id" | "slug" | "snapshotDigest">>) {
    const loaded = await loadFolder(gov, workspace.slug);
    if (!loaded.manifest) {
      log("warn", "workspace.reconcile_invalid", { workspace: workspace.slug, problems: loaded.problems.map((problem) => `${problem.path}: ${problem.message}`).join("; ") });
      continue;
    }
    const committed: Committed = { commit: loaded.commit, snapshotDigest: storeSnapshot(gov, { ...loaded, manifest: loaded.manifest }), manifest: loaded.manifest, paths: [] };
    if (committed.snapshotDigest !== workspace.snapshotDigest) {
      tx(gov.db, () => activate(gov, gov.db, workspace.id, committed, SYSTEM, "workspace.changed"));
      log("info", "workspace.reconciled", { workspace: workspace.slug, commit: committed.commit.slice(0, 12) });
    }
  }
}
