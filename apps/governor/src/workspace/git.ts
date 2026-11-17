import git from "isomorphic-git";
import fs from "node:fs";
import { dirname, join } from "node:path";
import type { Files } from "./files";

/** A workspace folder is a git repository; these are the only git operations Brain does on it. */
export interface Author { readonly name: string; readonly email: string }
export interface Change { readonly write: ReadonlyMap<string, Uint8Array>; readonly remove: readonly string[]; readonly message: string; readonly author: Author }

/** The commit HEAD names and every file of it. */
export async function readHead(dir: string): Promise<{ commit: string; files: Files }> {
  const cache = {};
  const commit = await git.resolveRef({ fs, dir, ref: "HEAD" });
  const files: Files = new Map();
  for (const path of await git.listFiles({ fs, dir, ref: commit, cache })) files.set(path, (await git.readBlob({ fs, dir, oid: commit, filepath: path, cache })).blob);
  return { commit, files };
}

/** Writes and removes files in the folder and commits exactly that. Returns the new commit. */
export async function commitChange(dir: string, change: Change): Promise<string> {
  if (!fs.existsSync(join(dir, ".git"))) await git.init({ fs, dir, defaultBranch: "main" });
  const cache = {};
  for (const [path, bytes] of change.write) {
    fs.mkdirSync(dirname(join(dir, path)), { recursive: true });
    fs.writeFileSync(join(dir, path), bytes);
    await git.add({ fs, dir, filepath: path, cache });
  }
  for (const path of change.remove) {
    fs.rmSync(join(dir, path), { force: true });
    await git.remove({ fs, dir, filepath: path, cache });
  }
  return git.commit({ fs, dir, message: change.message, author: change.author, cache });
}

/** HEAD's commit and, for every file, its blob id: no file is read. */
export async function listHead(dir: string): Promise<{ commit: string; blobs: Map<string, string> }> {
  const commit = await git.resolveRef({ fs, dir, ref: "HEAD" });
  const blobs = new Map<string, string>();
  await git.walk({
    fs, dir, trees: [git.TREE({ ref: commit })],
    map: async (filepath, [entry]) => {
      if (entry && (await entry.type()) === "blob") blobs.set(filepath, await entry.oid());
      return filepath;
    },
  });
  return { commit, blobs };
}

const sizes = new Map<string, number>();
/** The size of a blob; a blob never changes, so it is read once. */
export async function blobSize(dir: string, oid: string): Promise<number> {
  let size = sizes.get(oid);
  if (size === undefined) {
    size = (await git.readBlob({ fs, dir, oid })).blob.length;
    if (sizes.size > 20_000) sizes.clear();
    sizes.set(oid, size);
  }
  return size;
}

/** One file of a commit. */
export async function readBlobAt(dir: string, commit: string, filepath: string): Promise<Uint8Array | undefined> {
  try {
    return (await git.readBlob({ fs, dir, oid: commit, filepath })).blob;
  } catch {
    return undefined;
  }
}

export interface LastCommit { readonly message: string; readonly atMs: number }
const history = new Map<string, Map<string, LastCommit>>();
/** For each file of a commit, the last commit that changed it: one pass over the last 300 commits, kept per head commit. A file older than that has none. */
export async function lastCommits(dir: string, head: string, paths: ReadonlySet<string>): Promise<Map<string, LastCommit>> {
  const key = `${dir}\0${head}`;
  const kept = history.get(key);
  if (kept) return kept;
  const found = new Map<string, LastCommit>();
  try {
    for (const entry of await git.log({ fs, dir, ref: head, depth: 300 })) {
      const parent = entry.commit.parent[0];
      const changed: string[] = [];
      await git.walk({
        fs, dir, trees: [git.TREE({ ref: entry.oid }), ...(parent ? [git.TREE({ ref: parent })] : [])],
        map: async (filepath, [now, before]) => {
          if (now && (await now.type()) === "blob" && (!before || (await now.oid()) !== (await before.oid()))) changed.push(filepath);
          return filepath;
        },
      });
      for (const path of changed) if (paths.has(path) && !found.has(path)) found.set(path, { message: entry.commit.message.trim().split("\n")[0] ?? "", atMs: entry.commit.committer.timestamp * 1000 });
      if (found.size === paths.size) break;
    }
  } catch { /* a folder without history lists without commits */ }
  if (history.size >= 32) history.clear();
  history.set(key, found);
  return found;
}

/** Marks a commit with a name (`base@2`) that is never moved. */
export async function tagCommit(dir: string, name: string, commit: string): Promise<void> {
  await git.tag({ fs, dir, ref: name, object: commit });
}
/** The tags of the folder with the commit each names. */
export async function tags(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!fs.existsSync(join(dir, ".git"))) return found;
  for (const name of await git.listTags({ fs, dir })) found.set(name, await git.resolveRef({ fs, dir, ref: `refs/tags/${name}` }));
  return found;
}
/** The files of a commit under a folder, with paths relative to it. */
export async function readFolderAt(dir: string, commit: string, prefix: string): Promise<Files> {
  const cache = {};
  const files: Files = new Map();
  for (const path of await git.listFiles({ fs, dir, ref: commit, cache })) if (path.startsWith(prefix)) files.set(path.slice(prefix.length), (await git.readBlob({ fs, dir, oid: commit, filepath: path, cache })).blob);
  return files;
}
