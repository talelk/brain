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

/** The message and time of the last commit that changed a file, or undefined when the file has no history. */
export async function lastCommitOf(dir: string, filepath: string): Promise<{ message: string; atMs: number } | undefined> {
  try {
    const [entry] = await git.log({ fs, dir, filepath, depth: 1 });
    return entry ? { message: entry.commit.message.trim().split("\n")[0] ?? "", atMs: entry.commit.committer.timestamp * 1000 } : undefined;
  } catch {
    return undefined;
  }
}
