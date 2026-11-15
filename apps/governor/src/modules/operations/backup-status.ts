import { existsSync, readFileSync, statSync } from "node:fs";
import type { ProbeStatus } from "./probes";

/**
 * What Health says about backups (ADR 0038). The Governor never runs or schedules a backup: the host job (deploy/demo/backup) records when
 * a backup finished in `BRAIN_BACKUP_STAMP_FILE` and the outcome of its monthly restore rehearsal in `BRAIN_RESTORE_TEST_FILE`. Here those
 * two records are only read, and what they say is never improved on: no record is a warning, not a pass.
 */
export interface BackupLine {
  readonly status: ProbeStatus;
  readonly detail: string;
  /** When the recorded event finished; null when nothing is recorded. */
  readonly lastAt: string | null;
  readonly ageSeconds: number | null;
}
export interface RestoreTestLine extends BackupLine {
  /** What the rehearsal restored, as its host job recorded it. */
  readonly backup?: string;
  readonly databases?: number;
  readonly seconds?: number;
}

/** 36 hours: the same line the BrainBackupStale alert rule draws (a nightly job plus slack). */
const DEFAULT_BACKUP_STALE_SECONDS = 129_600;
/** The rehearsal runs monthly; a missed month is stale. */
const DEFAULT_RESTORE_TEST_STALE_SECONDS = 40 * 86_400;
const CLOCK_SKEW_MS = 60_000;

const positive = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value >= 60 ? value : fallback;
};

/** "5 hours", "2 days": the age in the largest whole unit that keeps it readable. */
export function ageWords(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds < 120) return unit(seconds, "second");
  if (seconds < 7_200) return unit(Math.round(seconds / 60), "minute");
  if (seconds < 172_800) return unit(Math.round(seconds / 3_600), "hour");
  return unit(Math.round(seconds / 86_400), "day");
}

const absent = (status: ProbeStatus, detail: string): BackupLine => ({ status, detail, lastAt: null, ageSeconds: null });
const ageOf = (atMs: number, nowMs: number): number => Math.max(0, Math.round((nowMs - atMs) / 1000));

function readText(path: string): string | undefined {
  try { return existsSync(path) && statSync(path).size <= 64 * 1024 ? readFileSync(path, "utf8") : undefined; } catch { return undefined; }
}

/** The last backup, from the epoch-seconds stamp the host backup job writes after each successful run. */
export function backupStatus(nowMs: number, env: NodeJS.ProcessEnv = process.env): BackupLine {
  const file = env["BRAIN_BACKUP_STAMP_FILE"];
  if (!file) return absent("disabled", "Backups are not tracked here. Set BRAIN_BACKUP_STAMP_FILE to the file your backup job writes its finish time into, and Health will show the last backup and warn when it is stale.");
  const text = readText(file);
  const seconds = text === undefined ? Number.NaN : Number(text.trim());
  const atMs = seconds * 1000;
  if (!Number.isFinite(seconds) || seconds <= 0 || atMs > nowMs + CLOCK_SKEW_MS) {
    return absent("degraded", "No successful backup has been recorded yet. Run the backup job and read its log on the server; until it records a finish time, restoring from a backup is not proven.");
  }
  const stale = positive(env["BRAIN_BACKUP_STALE_SECONDS"], DEFAULT_BACKUP_STALE_SECONDS);
  const age = ageOf(atMs, nowMs);
  const lastAt = new Date(atMs).toISOString();
  if (age > stale * 3) return { status: "unavailable", lastAt, ageSeconds: age, detail: `The last backup finished ${ageWords(age)} ago, far past the ${ageWords(stale)} limit. Brain has no recent copy to restore from: run the backup now and read its log on the server.` };
  if (age > stale) return { status: "degraded", lastAt, ageSeconds: age, detail: `The last backup finished ${ageWords(age)} ago, past the ${ageWords(stale)} limit (stale). Run the backup by hand and read its log on the server.` };
  return { status: "healthy", lastAt, ageSeconds: age, detail: `The last backup finished ${ageWords(age)} ago.` };
}

interface RestoreTestRecord { ok?: unknown; at?: unknown; backup?: unknown; databases?: unknown; seconds?: unknown }

/** The last restore test: the monthly rehearsal restores the newest backup into a scratch directory and checks every database. */
export function restoreTestStatus(nowMs: number, env: NodeJS.ProcessEnv = process.env): RestoreTestLine {
  const file = env["BRAIN_RESTORE_TEST_FILE"];
  if (!file) return absent("disabled", "Restore tests are not tracked here. Set BRAIN_RESTORE_TEST_FILE to the file your restore rehearsal writes its result into, and Health will show the last one.");
  const text = readText(file);
  if (text === undefined) return absent("degraded", "No restore test has been recorded yet. A backup that was never restored is not proven: run the restore rehearsal and read its log on the server.");
  let record: RestoreTestRecord;
  try { record = JSON.parse(text) as RestoreTestRecord; } catch { return absent("degraded", "The last restore test record could not be read. Run the restore rehearsal again and read its log on the server."); }
  const atMs = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
  if (!Number.isFinite(atMs) || atMs > nowMs + CLOCK_SKEW_MS || typeof record.ok !== "boolean") {
    return absent("degraded", "The last restore test record could not be read. Run the restore rehearsal again and read its log on the server.");
  }
  const age = ageOf(atMs, nowMs);
  const lastAt = new Date(atMs).toISOString();
  const safeName = (value: unknown): string | undefined => (typeof value === "string" && /^[\w.:-]{1,128}$/u.test(value) ? value : undefined);
  const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9 ? Math.round(value) : undefined);
  const backup = safeName(record.backup), databases = count(record.databases), seconds = count(record.seconds);
  const facts = { ...(backup ? { backup } : {}), ...(databases !== undefined ? { databases } : {}), ...(seconds !== undefined ? { seconds } : {}) };
  const what = `${databases !== undefined ? `${databases} database${databases === 1 ? "" : "s"}` : "the databases"}${seconds !== undefined ? ` in ${ageWords(seconds)}` : ""}`;
  if (!record.ok) return { status: "unavailable", lastAt, ageSeconds: age, ...facts, detail: `The last restore test, ${ageWords(age)} ago, failed. Backups may not restore: read the restore rehearsal log on the server and fix it before relying on them.` };
  const stale = positive(env["BRAIN_RESTORE_TEST_STALE_SECONDS"], DEFAULT_RESTORE_TEST_STALE_SECONDS);
  if (age > stale) return { status: "degraded", lastAt, ageSeconds: age, ...facts, detail: `The last restore test passed ${ageWords(age)} ago, past the ${ageWords(stale)} limit (stale). Run the restore rehearsal again.` };
  return { status: "healthy", lastAt, ageSeconds: age, ...facts, detail: `The last restore test passed ${ageWords(age)} ago: ${what} restored and checked.` };
}
