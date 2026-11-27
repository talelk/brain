import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backup, restore } from "../../apps/governor/src/health/backup";
import { enrolRunner } from "./driver";
import { createHarness, type Harness } from "./harness";
import { getTask, makeWorkspace, pass } from "./work";

/** Backup and restore of a data directory (docs/architecture.md section 9): what `pnpm brain backup` and `pnpm brain restore` do. */
let harness: Harness | undefined;
const scratch = mkdtempSync(join(tmpdir(), "brain-backups-"));
afterEach(() => {
  harness?.close();
  harness = undefined;
});

const play = 'title = "One step"\n[[step]]\nid = "work"\nagent = "dev"\ngoal = "Do the work."\n';

describe("a backup", () => {
  it("is made while the Governor runs, and restoring it brings back the workspaces, the record, the secrets and the sessions as they were", async () => {
    harness = await createHarness();
    const { workspaceId } = await makeWorkspace(harness, "Kept", { agents: { dev: {} }, plays: { one: play }, memory: { welcome: "---\ntype: Note\ntitle: Welcome\n---\n\nKept across a restore.\n" } });
    await harness.admin.command("secret.set", { workspaceId, name: "github", value: "ghp-kept" });
    const driver = await enrolRunner(harness, { checker: () => pass(), dev: async (turn) => { await turn.upload("report.md", "# Report\n"); return "Done before the backup."; } });
    const { taskId } = await harness.admin.command("task.create", { workspaceId, play: "one" });
    await driver.drain();
    const before = await getTask(harness.admin, workspaceId, taskId);
    expect((await harness.admin.query("health", { workspaceId })).backup.lastAt).toBeNull();

    const file = join(scratch, "first.tar.gz");
    expect(await backup(harness.dataDir, file)).toEqual({ file });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await harness.admin.query("health", { workspaceId })).backup.lastAt).toBeGreaterThan(Date.now() - 60_000);
    await expect(backup(harness.dataDir, file)).rejects.toThrow(/already exists/u);

    // What happens after the backup is not in it.
    const later = await makeWorkspace(harness, "Made later");
    await harness.admin.command("secret.delete", { workspaceId, name: "github" });
    await harness.admin.command("file.write", { workspaceId, files: [{ path: "memory/welcome.md", content: "---\ntype: Note\ntitle: Welcome\n---\n\nChanged after the backup.\n" }] });
    harness.governor.close();
    writeFileSync(join(harness.dataDir, "note-of-the-old-data.txt"), "still here\n");

    const { kept } = restore(file, harness.dataDir);
    // The data that was in place is moved aside, never deleted.
    expect(readFileSync(join(kept ?? "", "note-of-the-old-data.txt"), "utf8")).toBe("still here\n");
    expect(existsSync(join(harness.dataDir, "note-of-the-old-data.txt"))).toBe(false);
    await harness.restart();

    // The same person is still signed in: the instance key that signs sessions and encrypts secrets came back with the data.
    expect((await harness.admin.query("me", {})).workspaces.map((workspace) => workspace.id)).toEqual([workspaceId]);
    await expect(harness.admin.query("workspace.get", { workspaceId: later.workspaceId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await harness.admin.query("secrets.list", { workspaceId })).secrets.map((secret) => secret.name)).toEqual(["github"]);
    expect((await harness.admin.query("file.read", { workspaceId, path: "memory/welcome.md" })).content).toContain("Kept across a restore.");
    const after = await getTask(harness.admin, workspaceId, taskId);
    expect(after).toMatchObject({ state: "done", result: "Done before the backup." });
    expect(after.attempts).toEqual(before.attempts);
    const report = after.artifacts.find((artifact) => artifact.name === "report.md");
    expect(await (await harness.admin.fetch(`/v1/artifacts/${report?.digest}`)).text()).toBe("# Report\n");
    expect(await harness.admin.query("audit.verify", {})).toMatchObject({ ok: true });
    // The restored Governor works on: a new goal runs to a checked result on the runner that was enrolled before.
    const again = await harness.admin.command("task.create", { workspaceId, play: "one" });
    await driver.drain();
    expect((await getTask(harness.admin, workspaceId, again.taskId)).state).toBe("done");
    rmSync(kept ?? "", { recursive: true, force: true });
  });

  it("holds the key that signs the git store's tokens and the store's repositories, and puts both back", async () => {
    harness = await createHarness();
    const store = join(scratch, "live-store");
    const ref = join(store, "ws1", "app.git", "HEAD");
    mkdirSync(join(store, "ws1", "app.git"), { recursive: true });
    writeFileSync(ref, "ref: refs/heads/main\n");
    writeFileSync(join(harness.dataDir, "store.key"), "the private key");
    writeFileSync(join(harness.dataDir, "store.pub"), "the public key");
    const file = join(scratch, "with-store.tar.gz");
    await backup(harness.dataDir, file, store);
    writeFileSync(ref, "changed after the backup\n");
    const data = join(scratch, "restored", "data");
    const restored = restore(file, data, store);
    expect([readFileSync(join(data, "store.key"), "utf8"), readFileSync(join(data, "store.pub"), "utf8")]).toEqual(["the private key", "the public key"]);
    expect(readFileSync(ref, "utf8")).toBe("ref: refs/heads/main\n");
    // What the store held is moved aside like the data, never deleted, and the store is not left inside the data.
    expect(readFileSync(join(restored.keptStore ?? "", "ws1", "app.git", "HEAD"), "utf8")).toBe("changed after the backup\n");
    expect(existsSync(join(data, "store"))).toBe(false);
  });

  it("restores into an empty place, and refuses a file that is not a backup without touching what is there", async () => {
    harness = await createHarness();
    const { workspaceId } = await makeWorkspace(harness, "Moved");
    const file = join(scratch, "second.tar.gz");
    await backup(harness.dataDir, file);
    const elsewhere = join(scratch, "elsewhere", "data");
    expect(restore(file, elsewhere)).toEqual({ kept: null, keptStore: null });
    expect(statSync(elsewhere).mode & 0o777).toBe(0o700);
    expect(existsSync(join(elsewhere, "brain.db")) && existsSync(join(elsewhere, "workspaces", "moved", "brain.toml"))).toBe(true);
    expect(existsSync(join(elsewhere, "backup.marker"))).toBe(false);

    const notOne = join(scratch, "not-a-backup.tar.gz");
    writeFileSync(notOne, "these are not the bytes of an archive");
    expect(() => restore(notOne, harness!.dataDir)).toThrow(/could not be read as a backup/u);
    expect(() => restore(join(scratch, "missing.tar.gz"), harness!.dataDir)).toThrow(/does not exist/u);
    expect((await harness.admin.query("me", {})).workspaces.map((workspace) => workspace.id)).toEqual([workspaceId]);
    await expect(backup(join(scratch, "no-data-here"), join(scratch, "third.tar.gz"))).rejects.toThrow(/nothing to back up/u);
    rmSync(scratch, { recursive: true, force: true });
  });
});
