import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Backup and restore of a data directory (`pnpm brain backup`, `pnpm brain restore`). A backup is one `.tar.gz` holding everything a
 * Governor needs to come back as it was: a consistent copy of `brain.db` taken through SQLite's backup API (so it can be made while the
 * Governor runs), `cas/`, `workspaces/`, and the two things the copy cannot be read without, `instance.key` (it encrypts the secrets
 * and keys the sign-in sessions) and `audit/` (the audit signing key). The archive therefore holds secrets: it is written owner-only.
 *
 * The database is copied first. Stored bytes are never rewritten, so every digest the copy names is in `cas/`; a workspace commit made
 * after the copy is taken up when the restored Governor starts, as after a crash.
 */
const PARTS = ["cas", "workspaces", "audit", "instance.key"] as const;
const stamp = (): string => new Date().toISOString().replace(/[:.]/gu, "-");

function tar(args: readonly string[]): { status: number; error: string } {
  const ran = spawnSync("tar", args, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
  if (ran.error) throw new Error(`tar could not be run: ${ran.error.message}`);
  return { status: ran.status ?? 1, error: ran.stderr.trim() };
}

/** Writes a backup of `dataDir` to `file` (never over an existing file) and leaves `<data>/backup.marker`, whose time the Health screen shows. */
export async function backup(dataDir: string, file: string): Promise<{ file: string }> {
  const data = resolve(dataDir);
  const target = resolve(file);
  if (!existsSync(join(data, "brain.db"))) throw new Error(`${data} holds no Brain database (brain.db), so there is nothing to back up`);
  if (existsSync(target)) throw new Error(`${target} already exists; a backup never replaces a file`);
  mkdirSync(dirname(target), { recursive: true });
  const staging = mkdtempSync(join(dirname(target), ".brain-backup-"));
  try {
    const source = new Database(join(data, "brain.db"), { readonly: true, fileMustExist: true });
    try {
      await source.backup(join(staging, "brain.db"));
    } finally {
      source.close();
    }
    const parts = PARTS.filter((part) => existsSync(join(data, part)));
    const partial = join(staging, basename(target));
    // tar answers 1 when a file changed while it was read (a workspace being committed at that moment): the copy is made again.
    let made = { status: 1, error: "" };
    for (let tries = 0; tries < 3 && made.status === 1; tries += 1) made = tar(["-czf", partial, "--exclude=*.part", "-C", staging, "brain.db", "-C", data, ...parts]);
    if (made.status !== 0) throw new Error(`the archive could not be written: ${made.error || `tar ended with ${made.status}`}`);
    chmodSync(partial, 0o600);
    renameSync(partial, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  writeFileSync(join(data, "backup.marker"), `${new Date().toISOString()} ${target}\n`, { mode: 0o600 });
  return { file: target };
}

/**
 * Puts the content of a backup in place of `dataDir`. The Governor of that directory must be stopped: the caller checks. What was there
 * is never deleted: it is moved beside the directory, and the answer says where.
 */
export function restore(file: string, dataDir: string): { kept: string | null } {
  const data = resolve(dataDir);
  const archive = resolve(file);
  if (!existsSync(archive)) throw new Error(`${archive} does not exist`);
  mkdirSync(dirname(data), { recursive: true });
  const staging = mkdtempSync(`${data}.restore-`);
  try {
    const read = tar(["-xzf", archive, "-C", staging, "--no-same-owner"]);
    if (read.status !== 0) throw new Error(`${archive} could not be read as a backup: ${read.error || `tar ended with ${read.status}`}`);
    if (!existsSync(join(staging, "brain.db")) || !existsSync(join(staging, "instance.key"))) throw new Error(`${archive} is not a Brain backup: it has no brain.db or no instance.key`);
    const db = new Database(join(staging, "brain.db"), { readonly: true, fileMustExist: true });
    try {
      const check = (db.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]?.integrity_check;
      if (check !== "ok") throw new Error(`the database in ${archive} is damaged: ${check ?? "no answer"}`);
    } finally {
      db.close();
    }
    chmodSync(staging, 0o700);
    const kept = existsSync(data) && readdirSync(data).length > 0 ? `${data}.before-restore-${stamp()}` : null;
    if (kept) renameSync(data, kept);
    else rmSync(data, { recursive: true, force: true });
    try {
      renameSync(staging, data);
    } catch (e) {
      if (kept) renameSync(kept, data);
      throw e;
    }
    return { kept };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}
