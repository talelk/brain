import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";

const ENV = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" };

export const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A temporary directory of this test run; removed when the tests of the file that asked for it are over. */
const made: string[] = [];
afterAll(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
export const tempDir = (label: string): string => { const dir = mkdtempSync(join(tmpdir(), `brain-runner-${label}-`)); made.push(dir); return dir; };

export function writeFiles(dir: string, files: Readonly<Record<string, string | Uint8Array>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** A bare repository (the "remote" a project names) with one commit on `main` holding these files, and a clone to commit more through. */
export function bareRepository(files: Readonly<Record<string, string | Uint8Array>>): { repo: string; clone: string; head(): string; commit(files: Readonly<Record<string, string | Uint8Array>>, message: string): string } {
  const root = tempDir("repo");
  const repo = join(root, "origin.git");
  const clone = join(root, "clone");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", repo);
  git(root, "clone", "--quiet", repo, clone);
  const commit = (changed: Readonly<Record<string, string | Uint8Array>>, message: string): string => {
    writeFiles(clone, changed);
    git(clone, "add", "--all");
    git(clone, "commit", "--quiet", "-m", message);
    git(clone, "push", "--quiet", "origin", "HEAD:main");
    return git(clone, "rev-parse", "HEAD");
  };
  git(clone, "checkout", "--quiet", "-b", "main");
  commit(files, "first");
  return { repo, clone, head: () => git(clone, "rev-parse", "HEAD"), commit };
}
