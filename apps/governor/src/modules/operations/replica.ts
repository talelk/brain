import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrainDomainError } from "../../domain/errors";
import { createBackup, restoreBackup } from "./backup";
import type { ProbeStatus } from "./probes";

/**
 * Continuous replication of the databases to a second host (ADR 0027). Every interval the Governor takes an online snapshot of every
 * SQLite database (and the key file) into the replica directory in the local backup format, mirrors the content-addressed store
 * (immutable files, copied once), and records when. A host timer then ships that directory to the second host and records what it
 * shipped; Health reports the age of the newest snapshot that reached the second host as "replica lag". Nothing here runs unless
 * `BRAIN_REPLICA_DIR` is set. The recovery point is therefore the interval plus the shipping delay, not zero: a WAL-shipping sidecar
 * would do better and is a backlog row; this one needs no extra binary and restores with the existing `maintenance restore` machinery.
 */
export interface ReplicaConfig {
  readonly dir: string;
  readonly intervalSeconds: number;
  /** Lag at which Health warns, and past which it is critical. */
  readonly warnSeconds: number;
  readonly criticalSeconds: number;
  /** Written by the host's shipper after each copy to the second host; when set, lag is measured to what reached it. */
  readonly shippedFile: string | null;
  /** Snapshots kept locally. */
  readonly keep: number;
}

export function replicaConfig(env: NodeJS.ProcessEnv = process.env): ReplicaConfig | undefined {
  const dir = env["BRAIN_REPLICA_DIR"];
  if (!dir) return undefined;
  const number = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new BrainDomainError("INVALID_ARGUMENT", `${name} must be a whole number from ${min} to ${max}`);
    return value;
  };
  const warnSeconds = number("BRAIN_REPLICA_WARN_SECONDS", 300, 10, 86_400);
  const criticalSeconds = number("BRAIN_REPLICA_CRITICAL_SECONDS", 900, 10, 604_800);
  if (criticalSeconds <= warnSeconds) throw new BrainDomainError("INVALID_ARGUMENT", "BRAIN_REPLICA_CRITICAL_SECONDS must be larger than BRAIN_REPLICA_WARN_SECONDS");
  return { dir, intervalSeconds: number("BRAIN_REPLICA_INTERVAL_SECONDS", 60, 5, 3600), warnSeconds, criticalSeconds, shippedFile: env["BRAIN_REPLICA_SHIPPED_FILE"] || null, keep: number("BRAIN_REPLICA_KEEP", 3, 1, 48) };
}

export interface ReplicaStatusFile { readonly snapshot: string; readonly snapshotAtMs: number; readonly files: number; readonly bytes: number; readonly durationMs: number; readonly casFilesCopied: number }

const SNAPSHOTS = "snapshots";
const writeAtomic = (path: string, text: string): void => { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, path); };
/** Paths left out of the database snapshot: the content-addressed store is mirrored separately, partial uploads are not state. */
const skipped = (path: string): boolean => path === "cas" || path === "upload-tmp";

/** Copies content-addressed files the replica does not hold yet. A digest names one file for ever, so an existing file is never touched. */
export function mirrorCas(dataDir: string, replicaDir: string): number {
  const from = join(dataDir, "cas");
  if (!existsSync(from)) return 0;
  let copied = 0;
  for (const shard of readdirSync(from, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const target = join(replicaDir, "cas", shard.name);
    for (const file of readdirSync(join(from, shard.name), { withFileTypes: true })) {
      if (!file.isFile() || file.name.endsWith(".part")) continue;
      const destination = join(target, file.name);
      if (existsSync(destination)) continue;
      mkdirSync(target, { recursive: true, mode: 0o700 });
      const temporary = `${destination}.${process.pid}.tmp`;
      copyFileSync(join(from, shard.name, file.name), temporary);
      renameSync(temporary, destination);
      copied++;
    }
  }
  return copied;
}

/** One replication cycle: snapshot, mirror, record. Older snapshots beyond `keep` are removed only after the new one is complete and named. */
export async function replicateOnce(dataDir: string, config: ReplicaConfig, now: () => number = Date.now): Promise<ReplicaStatusFile> {
  const started = now();
  mkdirSync(join(config.dir, SNAPSHOTS), { recursive: true, mode: 0o700 });
  const name = `snap-${String(started).padStart(15, "0")}`;
  const manifest = await createBackup(dataDir, join(config.dir, SNAPSHOTS, name), { live: true, skip: skipped });
  const casFilesCopied = mirrorCas(dataDir, config.dir);
  const status: ReplicaStatusFile = { snapshot: name, snapshotAtMs: started, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), durationMs: now() - started, casFilesCopied };
  writeAtomic(join(config.dir, "replica-status.json"), JSON.stringify(status));
  for (const old of readdirSync(join(config.dir, SNAPSHOTS)).filter((entry) => entry.startsWith("snap-")).sort().slice(0, -config.keep)) rmSync(join(config.dir, SNAPSHOTS, old), { recursive: true, force: true });
  return status;
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

export interface ReplicaLag { readonly status: ProbeStatus; readonly detail: string; readonly lagSeconds: number | null; readonly snapshotAtMs: number | null }

/** The replica's freshness for Health and metrics. `disabled` when no replica is configured. */
export function replicaLag(config: ReplicaConfig | undefined, nowMs: number): ReplicaLag {
  if (!config) return { status: "disabled", detail: "No replica is configured. Set BRAIN_REPLICA_DIR to copy the databases continuously to a second host.", lagSeconds: null, snapshotAtMs: null };
  const local = readJson<ReplicaStatusFile>(join(config.dir, "replica-status.json"));
  if (!local) return { status: "degraded", detail: "No replica snapshot has been written yet.", lagSeconds: null, snapshotAtMs: null };
  const shipped = config.shippedFile ? readJson<{ shippedSnapshotAtMs?: number; shippedAtMs?: number }>(config.shippedFile) : undefined;
  // With a shipper, only what reached the second host counts; without a shipped record the lag is that of the local snapshot, and says so.
  const reference = config.shippedFile ? shipped?.shippedSnapshotAtMs ?? null : local.snapshotAtMs;
  const lagSeconds = reference === null ? Math.max(0, Math.round((nowMs - local.snapshotAtMs) / 1000)) : Math.max(0, Math.round((nowMs - reference) / 1000));
  const words = `${lagSeconds < 120 ? `${lagSeconds} seconds` : `${Math.round(lagSeconds / 60)} minutes`}`;
  const where = config.shippedFile ? (reference === null ? "Nothing has reached the second host yet" : "The newest copy on the second host is") : "The newest local snapshot is";
  const status: ProbeStatus = lagSeconds > config.criticalSeconds ? "unavailable" : lagSeconds > config.warnSeconds || reference === null && config.shippedFile ? "degraded" : "healthy";
  const detail = reference === null && config.shippedFile ? `${where}; the local snapshot is ${words} old. Check the replica shipping timer on the host.`
    : status === "healthy" ? `Replica lag is ${words}: ${where} ${words} old.` : `Replica lag is ${words}: ${where} ${words} old. A failover now would lose that much work; check the replica shipping on the host.`;
  return { status, detail, lagSeconds, snapshotAtMs: local.snapshotAtMs };
}

/** The newest complete snapshot in a replica directory (the one LATEST names is written last, so it is always whole). */
export function latestSnapshot(replicaDir: string): string {
  const root = join(replicaDir, SNAPSHOTS);
  const names = existsSync(root) ? readdirSync(root).filter((entry) => entry.startsWith("snap-") && existsSync(join(root, entry, "manifest.json"))).sort() : [];
  const newest = names.at(-1);
  if (!newest) throw new BrainDomainError("EVIDENCE_MISSING", "the replica directory holds no complete snapshot");
  return join(root, newest);
}

/**
 * Brings a data directory back from a replica copy: verifies the newest snapshot (every file digest, every database integrity), restores
 * it into an empty directory the usual way (suspended until an operator resumes it), then restores the mirrored content-addressed files.
 */
export function restoreFromReplica(replicaDir: string, intoDir: string): { snapshot: string; casFiles: number } {
  const snapshot = latestSnapshot(replicaDir);
  restoreBackup(snapshot, intoDir);
  let casFiles = 0;
  const cas = join(replicaDir, "cas");
  if (existsSync(cas)) {
    for (const shard of readdirSync(cas, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      mkdirSync(join(intoDir, "cas", shard.name), { recursive: true, mode: 0o700 });
      for (const file of readdirSync(join(cas, shard.name), { withFileTypes: true })) {
        if (!file.isFile() || file.name.endsWith(".tmp") || !statSync(join(cas, shard.name, file.name)).isFile()) continue;
        copyFileSync(join(cas, shard.name, file.name), join(intoDir, "cas", shard.name, file.name));
        casFiles++;
      }
    }
  }
  return { snapshot: snapshot.split("/").at(-1) ?? snapshot, casFiles };
}
