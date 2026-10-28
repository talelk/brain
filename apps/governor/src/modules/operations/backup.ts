import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { sha256Digest } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { acquireDirectory, assertRegularFile, durableWrite, OWNER_FILE } from "../../infrastructure/persistence/directory";

// Local archive framing, distinct from the product BackupManifest which also
// requires knowledge exports, adapter releases, scope and authority watermarks.
const manifestSchema = z.object({
  format: z.literal("brain.local-backup/v1"),
  backupId: z.uuid(),
  createdAt: z.iso.datetime(),
  files: z.array(z.object({ path: z.string().min(1).max(1024), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), bytes: z.number().int().min(0).max(10 * 1024 ** 3) }).strict()).min(1).max(100_000),
  completeness: z.enum(["partial", "complete"]),
  missing: z.array(z.string().min(1).max(256)).max(100),
  // T47: authority watermarks and the pinned adapter/config inventory ride in
  // the archive so a restore can prove what authority generation it carries.
  authority: z.object({
    organizations: z.array(z.object({
      id: z.string().min(1).max(256),
      revocationGeneration: z.number().int().min(1),
      activeReleaseDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullable(),
      primitiveVersions: z.number().int().min(0),
    })).max(10_000),
    mastraLibsqlSnapshot: z.boolean(),
    memoryMode: z.enum(["local", "tencentdb"]),
  }).strict().optional(),
}).strict();
export type LocalBackupManifest = z.infer<typeof manifestSchema>;
const reserved = new Set(["manifest.json", "RESTORED-SUSPENDED.json", "RESTORED-APPLIED.json", OWNER_FILE, `${OWNER_FILE}-journal`]);

function invalid(message: string): never { throw new BrainDomainError("EVIDENCE_MISSING", message); }

function hasPath(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

function safePath(path: string): void {
  if (isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((s) => !s || s === "." || s === "..") || reserved.has(path) || /-(?:wal|shm|journal)$/u.test(path)) {
    invalid("unsafe backup file path");
  }
}

function directory(path: string): string {
  const full = resolve(path);
  // Reject links in every ancestor, including a destination's parent.
  for (let p = full; ; p = dirname(p)) {
    const st = lstatSync(p);
    if (!st.isDirectory() || st.isSymbolicLink()) invalid("backup paths must use real directories");
    if (dirname(p) === p) break;
  }
  return realpathSync(full);
}

function disjoint(a: string, b: string): void {
  const within = (parent: string, child: string) => { const r = relative(parent, child); return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r)); };
  if (within(a, b) || within(b, a)) throw new BrainDomainError("CONFLICT", "source and destination must not overlap");
}

function collect(root: string, prefix = "", out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (reserved.has(path)) continue;
    if (entry.isDirectory()) collect(root, path, out);
    else {
      assertRegularFile(join(root, path));
      // SQLite backup reads committed WAL pages; sidecars are never copied.
      if (/-(?:wal|shm|journal)$/u.test(path) && existsSync(join(root, path.replace(/-(?:wal|shm|journal)$/u, "")))) continue;
      safePath(path);
      out.push(path);
    }
  }
  return out.sort();
}

function checkSqlite(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok" || (db.pragma("foreign_key_check") as unknown[]).length !== 0) invalid("backup database failed integrity checks");
  } finally { db.close(); }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncTree(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) syncTree(join(path, entry.name));
  }
  syncDirectory(path);
}

function destination(path: string): { stage: string; publish: () => void } {
  const full = join(directory(dirname(resolve(path))), resolve(path).split(sep).at(-1)!);
  if (hasPath(full) && (directory(full) !== full || readdirSync(full).length !== 0)) throw new BrainDomainError("CONFLICT", "destination must be empty");
  const stage = mkdtempSync(join(dirname(full), ".brain-stage-"));
  chmodSync(stage, 0o700);
  return { stage, publish() {
    syncTree(stage);
    if (hasPath(full)) rmdirSync(full); // fails if anything appeared meanwhile
    renameSync(stage, full);
    syncDirectory(dirname(full));
  } };
}

function copyVerified(root: string, path: string, expected?: { digest: string; bytes: number }, destination?: string): { digest: string; bytes: number } {
  directory(dirname(join(root, path)));
  const source = join(root, path);
  assertRegularFile(source);
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 10 * 1024 ** 3) invalid("invalid or oversized backup file");
    if (expected && stat.size !== expected.bytes) invalid(`backup hash mismatch ${path}`);
    if (destination) output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      total += n;
      if (total > stat.size) invalid("backup file changed while reading");
      hash.update(buffer.subarray(0, n));
      if (output !== undefined) {
        for (let offset = 0; offset < n;) offset += writeSync(output, buffer, offset, n - offset);
      }
    }
    const digest = `sha256:${hash.digest("hex")}`;
    if (total !== stat.size || (expected && digest !== expected.digest)) invalid(`backup hash mismatch ${path}`);
    if (output !== undefined) fsyncSync(output);
    return { digest, bytes: total };
  } finally { closeSync(fd); if (output !== undefined) closeSync(output); }
}

// Maintenance-only: one stopped Governor, WAL-aware database snapshots and an
// atomic directory publication. Other writers must also be stopped by operator.
export async function createBackup(dataDir: string, outDir: string): Promise<LocalBackupManifest> {
  const source = directory(dataDir);
  disjoint(source, resolve(outDir));
  const release = acquireDirectory(source);
  let stage: string | undefined;
  try {
    const paths = collect(source);
    if (!paths.includes("control.db")) invalid("backup requires control.db");
    const output = destination(outDir);
    stage = output.stage;
    const files: LocalBackupManifest["files"] = [];
    for (const path of paths) {
      const dest = join(stage, path);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      if (path.endsWith(".db")) {
        const db = new Database(join(source, path), { readonly: true, fileMustExist: true });
        try { await db.backup(dest); } finally { db.close(); }
        chmodSync(dest, 0o600);
        checkSqlite(dest);
        const fd = openSync(dest, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      const info = path.endsWith(".db") ? copyVerified(stage, path) : copyVerified(source, path, undefined, dest);
      files.push({ path, ...info });
    }
    // T47 inventory: local memory lives in control.db (memory_assets) and the
    // Mastra durable progression snapshot is the LibSQL storage under
    // dataDir/mastra — both are collected files above. Only a *configured
    // remote* TencentDB is outside the archive. Authority watermarks come
    // straight from the control snapshot.
    let authority: LocalBackupManifest["authority"];
    {
      const control = new Database(join(stage, "control.db"), { readonly: true, fileMustExist: true });
      try {
        const orgs = control.prepare("SELECT id, revocation_generation FROM organizations ORDER BY id").all() as Array<{ id: string; revocation_generation: number }>;
        const active = control.prepare("SELECT organization_id, release_digest FROM active_config").all() as Array<{ organization_id: string; release_digest: string }>;
        const activeByOrg = new Map(active.map((r) => [r.organization_id, r.release_digest]));
        authority = {
          organizations: orgs.map((o) => {
            let primitiveVersions = 0;
            const releaseDigest = activeByOrg.get(o.id) ?? null;
            if (releaseDigest) {
              const rel = control.prepare("SELECT manifest_json FROM config_releases WHERE digest=?").get(releaseDigest) as { manifest_json: string } | undefined;
              try {
                const parsed = JSON.parse(rel?.manifest_json ?? "{}") as { manifest?: { primitiveVersions?: Record<string, string> } };
                primitiveVersions = Object.keys(parsed.manifest?.primitiveVersions ?? {}).length;
              } catch { primitiveVersions = 0; }
            }
            return { id: o.id, revocationGeneration: o.revocation_generation, activeReleaseDigest: releaseDigest, primitiveVersions };
          }),
          mastraLibsqlSnapshot: existsSync(join(stage, "mastra")),
          memoryMode: process.env["BRAIN_TENCENTDB_URL"] ? "tencentdb" : "local",
        };
      } finally { control.close(); }
    }
    const missing: string[] = [];
    if (authority.memoryMode === "tencentdb") missing.push("tencentdb-memory", "tencentdb-wiki", "tencentdb-codegraph");
    const manifest: LocalBackupManifest = manifestSchema.parse({
      format: "brain.local-backup/v1", backupId: randomUUID(), createdAt: new Date().toISOString(), files,
      completeness: missing.length === 0 ? "complete" : "partial", missing,
      authority,
    });
    durableWrite(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
    output.publish();
    stage = undefined;
    return manifest;
  } finally { if (stage) rmSync(stage, { recursive: true, force: true }); release(); }
}

export function verifyBackup(dir: string): LocalBackupManifest {
  const root = directory(dir);
  assertRegularFile(join(root, "manifest.json"));
  if (lstatSync(join(root, "manifest.json")).size > 32 * 1024 ** 2) invalid("backup manifest too large");
  let manifest: LocalBackupManifest;
  try { manifest = manifestSchema.parse(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))); }
  catch { return invalid("invalid local backup manifest"); }
  const seen = new Set<string>();
  for (const f of manifest.files) {
    safePath(f.path);
    const key = f.path.toLowerCase();
    if (seen.has(key)) invalid("duplicate backup file path");
    seen.add(key);
  }
  if (!seen.has("control.db")) invalid("backup requires control.db");
  for (const f of manifest.files) {
    if (!existsSync(join(root, f.path))) invalid(`backup missing ${f.path}`);
    copyVerified(root, f.path, f);
    if (f.path.endsWith(".db")) checkSqlite(join(root, f.path));
  }
  return manifest;
}

export function restoreBackup(backupDir: string, intoDir: string): void {
  const root = directory(backupDir);
  disjoint(root, resolve(intoDir));
  const manifest = verifyBackup(root);
  const output = destination(intoDir);
  try {
    for (const f of manifest.files) {
      const dest = join(output.stage, f.path);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      copyVerified(root, f.path, f, dest);
    }
    durableWrite(join(output.stage, "RESTORED-SUSPENDED.json"), JSON.stringify({
      format: "brain.restore/v1", restoreId: randomUUID(), backupId: manifest.backupId,
      manifestDigest: sha256Digest(readFileSync(join(root, "manifest.json"))), restoredAt: new Date().toISOString(),
      authorityWatermarks: manifest.authority?.organizations ?? [],
    }, null, 2));
    output.publish();
  } finally { if (existsSync(output.stage)) rmSync(output.stage, { recursive: true, force: true }); }
}
