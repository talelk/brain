import { createBrainAuth } from "../../apps/governor/src/modules/identity/index";
import { seedOrganization } from "../helpers";
import Database from "better-sqlite3";
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Brain } from "../../apps/governor/src/application/brain";
import { Store } from "../../apps/governor/src/application/store";
import { createBackup, restoreBackup, verifyBackup, quarantineRestoredAuthority } from "../../apps/governor/src/modules/operations/index";
import { resolveActor } from "../../apps/governor/src/application/authz";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "brain-backup-safety-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("local backup integrity and confinement", () => {
  it("refuses a running Governor; includes committed WAL rows through SQLite backup", async () => {
    const source = temp();
    const brain = new Brain({ dataDir: source });
    seedOrganization(brain, { organizationId: "org-wal", ownerId: "owner-wal" });
    try {
      expect(() => new Brain({ dataDir: source })).toThrow(/in use/);
      await expect(createBackup(source, join(temp(), "live"))).rejects.toThrow(/in use/);
    } finally { brain.close(); }
    // Keep a writer connection open to prevent close-time WAL checkpointing.
    const writer = new Database(join(source, "control.db"));
    writer.pragma("journal_mode=WAL"); writer.pragma("wal_autocheckpoint=0");
    writer.exec("CREATE TABLE wal_proof(value TEXT); INSERT INTO wal_proof VALUES ('committed-only-in-wal')");
    expect(readFileSync(join(source, "control.db-wal")).length).toBeGreaterThan(32);
    try {
      const target = join(temp(), "backup");
      const manifest = await createBackup(source, target);
      expect(manifest.files.some((f) => /-(wal|shm)$/u.test(f.path))).toBe(false);
      const snapshot = new Database(join(target, "control.db"), { readonly: true });
      try { expect(snapshot.prepare("SELECT value FROM wal_proof").get()).toEqual({ value: "committed-only-in-wal" }); }
      finally { snapshot.close(); }
      expect(verifyBackup(target).backupId).toBe(manifest.backupId);
    } finally { writer.close(); }
  });

  it.each(["../escape", "/tmp/escape", "nested/../../escape", "nested\\escape", "a//b", "RESTORED-APPLIED.json", "control.db-wal"])("rejects unsafe manifest path %s before writing output", async (path) => {
    const source = temp(); const brain = new Brain({ dataDir: source }); brain.close();
    const archive = join(temp(), "archive");
    const manifest = await createBackup(source, archive);
    manifest.files[0]!.path = path;
    writeFileSync(join(archive, "manifest.json"), JSON.stringify(manifest));
    const dest = join(temp(), "restored");
    expect(() => restoreBackup(archive, dest)).toThrow(/unsafe/);
    expect(existsSync(dest)).toBe(false);
  });

  it("rejects duplicate paths and symbolic or hard linked contents", async () => {
    const source = temp(); const brain = new Brain({ dataDir: source }); brain.close();
    const archive = join(temp(), "archive"); const manifest = await createBackup(source, archive);
    writeFileSync(join(archive, "manifest.json"), JSON.stringify({ ...manifest, files: [...manifest.files, manifest.files[0]] }));
    expect(() => verifyBackup(archive)).toThrow(/duplicate/);
    writeFileSync(join(archive, "manifest.json"), JSON.stringify(manifest));
    const victim = join(archive, "authority.keys"); const external = join(temp(), "secret");
    writeFileSync(external, readFileSync(victim)); unlinkSync(victim); symlinkSync(external, victim);
    expect(() => verifyBackup(archive)).toThrow(/regular/);
    unlinkSync(victim); linkSync(external, victim);
    expect(() => verifyBackup(archive)).toThrow(/regular/);
  });

  it("does not publish a failed backup or overwrite an existing destination", async () => {
    const source = temp(); const brain = new Brain({ dataDir: source }); brain.close();
    writeFileSync(join(source, "broken.db"), "not a sqlite database");
    const parent = temp(); const dest = join(parent, "backup");
    await expect(createBackup(source, dest)).rejects.toThrow();
    expect(readdirSync(parent)).toEqual([]);
    unlinkSync(join(source, "broken.db"));
    await expect(createBackup(source, join(source, "nested"))).rejects.toThrow(/overlap/);
    const link = join(parent, "dangling");
    symlinkSync(join(parent, "missing"), link);
    await expect(createBackup(source, link)).rejects.toThrow();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    await createBackup(source, dest);
    const before = readFileSync(join(dest, "manifest.json"), "utf8");
    await expect(createBackup(source, dest)).rejects.toThrow(/empty/);
    expect(readFileSync(join(dest, "manifest.json"), "utf8")).toBe(before);
  });

  it("normal restart retains sessions; each new restore revokes them exactly once", async () => {
    const source = temp(); let brain = new Brain({ dataDir: source });
    const boot = seedOrganization(brain, { organizationId: "org-restart", ownerId: "owner-restart" });
    const account = await brain.auth.bootstrapAccount({ email: "restore@example.test", password: "restore-test-password", name: "Restore" });
    const sessionHeaders = new Headers({ authorization: `Bearer ${account.token}` });
    const vendorUser = (await brain.auth.readSession(sessionHeaders))?.userId;
    expect(vendorUser).toBeTruthy();
    brain.close();
    brain = new Brain({ dataDir: source });
    const headers = new Headers({ authorization: `Bearer ${boot.sessionToken}` });
    expect((await brain.resolveActor(headers)).actor.actorId).toBe(boot.ownerPrincipalId);
    expect((await brain.auth.readSession(sessionHeaders))?.userId).toBe(vendorUser); brain.close();
    const first = join(temp(), "first"); await createBackup(source, first);
    const restored = join(temp(), "data"); restoreBackup(first, restored);
    // A filesystem acknowledgement is never authority to skip the transaction.
    writeFileSync(join(restored, "RESTORED-APPLIED.json"), "{}");
    brain = new Brain({ dataDir: restored });
    await expect(brain.resolveActor(headers)).rejects.toThrow();
    expect(await brain.auth.readSession(sessionHeaders)).toBeNull();
    const generation = () => (brain.store.control.prepare("SELECT revocation_generation AS n FROM organizations").get() as { n: number }).n;
    expect(generation()).toBe(2); brain.close();
    unlinkSync(join(restored, "RESTORED-APPLIED.json"));
    brain = new Brain({ dataDir: restored }); expect(generation()).toBe(2); brain.close();
    const second = join(temp(), "second"); await createBackup(restored, second);
    const restoredAgain = join(temp(), "data"); restoreBackup(second, restoredAgain);
    brain = new Brain({ dataDir: restoredAgain }); expect(generation()).toBe(3); brain.close();
  });

  it("rolls back a quarantine fault before commit and retries on the next open", async () => {
    const source = temp(); const brain = new Brain({ dataDir: source });
    const boot = seedOrganization(brain, { organizationId: "org-crash", ownerId: "owner-crash" }); brain.close();
    const archive = join(temp(), "archive"); await createBackup(source, archive);
    const target = join(temp(), "data"); restoreBackup(archive, target);
    const store = new Store({ dataDir: target });
    const auth = createBrainAuth(store.control, { secret: Buffer.from(store.pepper).toString("hex"), baseURL: "http://127.0.0.1:3000" });
    const fault = vi.spyOn(store, "emit").mockImplementation(() => { throw new Error("injected pre-commit fault"); });
    try {
      expect(() => quarantineRestoredAuthority(store, { revokeAllSessions() {} })).toThrow(/pre-commit/);
      expect((await resolveActor(store, auth, new Headers({ authorization: `Bearer ${boot.sessionToken}` }))).actor.actorId).toBe(boot.ownerPrincipalId);
      expect(store.control.prepare("SELECT 1 FROM inbox WHERE source_id='operations.restore'").get()).toBeUndefined();
      expect(store.control.prepare("SELECT revocation_generation AS n FROM organizations").get()).toEqual({ n: 1 });
    } finally { fault.mockRestore(); store.close(); }
    const reopened = new Brain({ dataDir: target });
    try {
      expect(reopened.store.control.prepare("SELECT revocation_generation AS n FROM organizations").get()).toEqual({ n: 2 });
      await expect(reopened.resolveActor(new Headers({ authorization: `Bearer ${boot.sessionToken}` }))).rejects.toThrow();
    } finally { reopened.close(); }
  });

  it("refuses a changed restore identity and releases ownership after initialization failure", async () => {
    const source = temp(); const brain = new Brain({ dataDir: source }); brain.close();
    const archive = join(temp(), "archive"); await createBackup(source, archive);
    const target = join(temp(), "data"); restoreBackup(archive, target);
    const restored = new Brain({ dataDir: target }); restored.close();
    const marker = join(target, "RESTORED-SUSPENDED.json"); const original = readFileSync(marker, "utf8");
    writeFileSync(marker, JSON.stringify({ ...JSON.parse(original), restoredAt: "2026-01-01T00:00:00.000Z" }));
    expect(() => new Brain({ dataDir: target })).toThrow(/reused/);
    writeFileSync(marker, original);
    const reopened = new Brain({ dataDir: target }); reopened.close();
  });
});
