import { BrainError, type Digest, type FileEntry } from "@brain/contracts";
import type { Gov } from "../dispatch";
import { blobSize, lastCommits, listHead, readBlobAt } from "./git";
import { readPack, releasedDirOf } from "./files";
import { getWorkspace, manifestOf, workspaceDir } from "./store";
import { readArtifact } from "../trust/artifacts";

/** The source of a file that is a task's result, not part of the folder: read only, listed under `out/` and `work/`. */
export const RESULTS = "results";
interface Kept { readonly path: string; readonly digest: string; readonly bytes: number; readonly title: string; readonly atMs: number }

/**
 * What tasks kept (docs/model.md, "A workspace folder"): the files an attempt saved in `/out` as `out/<task>/<name>`, and the diff of the changes
 * it made to a project as `work/<task>/changes.patch`. The newest of two with the same path wins.
 */
function keptBy(gov: Gov, workspaceId: string): Kept[] {
  const rows = gov.db.prepare(
    `SELECT l.digest, l.name, l.kind, l.task_id AS taskId, l.created_at_ms AS atMs, a.bytes, t.title FROM artifact_links l JOIN artifacts a ON a.digest=l.digest JOIN tasks t ON t.id=l.task_id
     WHERE l.workspace_id=? AND l.kind IN ('output','patch') ORDER BY l.created_at_ms DESC, l.id DESC LIMIT 1000`,
  ).all(workspaceId) as Array<{ digest: string; name: string; kind: string; taskId: string; atMs: number; bytes: number; title: string }>;
  const seen = new Map<string, Kept>();
  for (const row of rows) {
    const path = row.kind === "output" ? `out/${row.taskId}/${row.name}` : `work/${row.taskId}/changes.patch`;
    if (!seen.has(path)) seen.set(path, { path, digest: row.digest, bytes: row.bytes, title: row.title, atMs: row.atMs });
  }
  return [...seen.values()];
}

/**
 * What a workspace holds, without loading and validating the folder (docs/architecture.md section 4): the folder's files from HEAD's tree,
 * and the files of its packs, in the order `loadWorkspace` applies them (required packs first, a later pack over an earlier one, the folder over all).
 */
async function placed(gov: Gov, workspaceId: string): Promise<{ dir: string; commit: string; blobs: Map<string, string>; packs: Map<string, { source: string; bytes: Uint8Array }> }> {
  const workspace = getWorkspace(gov.db, workspaceId);
  const dir = workspaceDir(gov, workspace.slug);
  const head = await listHead(dir);
  const packs = new Map<string, { source: string; bytes: Uint8Array }>();
  const manifest = manifestOf(gov, workspace.snapshotDigest);
  for (const name of manifest.packs) {
    for (const [path, bytes] of readPack(gov.packsDir, name, manifest.pins?.[name], releasedDirOf(gov.dataDir)) ?? []) if (path !== "pack.toml") packs.set(path, { source: name, bytes });
  }
  return { dir, ...head, packs };
}

export async function listFiles(gov: Gov, workspaceId: string): Promise<FileEntry[]> {
  const { dir, commit, blobs, packs } = await placed(gov, workspaceId);
  const commits = await lastCommits(dir, commit, new Set(blobs.keys()));
  const entries: FileEntry[] = [];
  for (const [path, oid] of blobs) {
    const replaced = packs.get(path)?.source;
    const last = commits.get(path);
    entries.push({ path, bytes: await blobSize(dir, oid), source: "workspace", ...(replaced ? { replaces: replaced } : {}), ...(last ? { lastCommit: last } : {}) });
  }
  for (const [path, file] of packs) if (!blobs.has(path)) entries.push({ path, bytes: file.bytes.length, source: file.source });
  for (const kept of keptBy(gov, workspaceId)) if (!blobs.has(kept.path)) entries.push({ path: kept.path, bytes: kept.bytes, source: RESULTS, lastCommit: { message: kept.title, atMs: kept.atMs } });
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** One file's bytes, where it comes from and, for a folder file, its last commit; the folder's own file wins over a pack's. */
export async function readFileOf(gov: Gov, workspaceId: string, path: string): Promise<{ bytes: Uint8Array } & FileEntryOrigin> {
  const workspace = getWorkspace(gov.db, workspaceId);
  const kept = /^(?:out|work)\//u.test(path) ? keptBy(gov, workspaceId).find((entry) => entry.path === path) : undefined;
  if (kept) return { bytes: readArtifact(gov, kept.digest as Digest), source: RESULTS, lastCommit: { message: kept.title, atMs: kept.atMs } };
  const dir = workspaceDir(gov, workspace.slug);
  const head = await listHead(dir);
  let pack: { source: string; bytes: Uint8Array } | undefined;
  if (path !== "pack.toml") {
    const manifest = manifestOf(gov, workspace.snapshotDigest);
    for (const name of manifest.packs) {
      const bytes = readPack(gov.packsDir, name, manifest.pins?.[name], releasedDirOf(gov.dataDir))?.get(path);
      if (bytes) pack = { source: name, bytes };
    }
  }
  const own = head.blobs.has(path) ? await readBlobAt(dir, head.commit, path) : undefined;
  if (own) {
    const last = (await lastCommits(dir, head.commit, new Set(head.blobs.keys()))).get(path);
    return { bytes: own, source: "workspace", ...(pack ? { replaces: pack.source } : {}), ...(last ? { lastCommit: last } : {}) };
  }
  if (!pack) throw new BrainError("NOT_FOUND", `The workspace has no file ${path}`);
  return pack;
}
interface FileEntryOrigin { readonly source: string; readonly replaces?: string; readonly lastCommit?: { readonly message: string; readonly atMs: number } }
