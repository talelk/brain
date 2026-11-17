import { BrainError, type FileEntry } from "@brain/contracts";
import type { Gov } from "../dispatch";
import { blobSize, lastCommits, listHead, readBlobAt } from "./git";
import { readPack, releasedDirOf } from "./files";
import { getWorkspace, manifestOf, workspaceDir } from "./store";

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
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** One file's bytes, where it comes from and, for a folder file, its last commit; the folder's own file wins over a pack's. */
export async function readFileOf(gov: Gov, workspaceId: string, path: string): Promise<{ bytes: Uint8Array } & FileEntryOrigin> {
  const workspace = getWorkspace(gov.db, workspaceId);
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
