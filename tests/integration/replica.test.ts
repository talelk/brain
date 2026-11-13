import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Brain } from "../../apps/governor/src/application/brain";
import { putBytes, readVerified } from "../../apps/governor/src/modules/artifacts/index";
import { runMaintenance } from "../../apps/governor/src/maintenance";
import { setupWorld, type TestWorld } from "../helpers";
import { command } from "../support/reuse";

// Continuous replication to a second host (ADR 0027): freshness shown in Health, a restore from the replica on a copy, a tampered
// replica refused, and nothing at all when no replica is configured.
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const temp = (name: string) => { const dir = mkdtempSync(join(tmpdir(), `brain-${name}-`)); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };

function withEnv<T>(values: Record<string, string>, run: () => T): T {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return run(); } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const health = async (w: TestWorld) => {
  await w.brain.runEngineProbes((async () => new Response("{}")) as unknown as typeof fetch);
  return ((await w.brain.executeQuery(w.owner, { queryType: "platform.health" })) as unknown as { snapshot: { status: string; services: Array<{ id: string; status: string; detail: string }> } }).snapshot;
};
const replicaLine = async (w: TestWorld) => (await health(w)).services.find((service) => service.id === "replica")!;

describe("replica freshness in Health", () => {
  it("is a disabled line, not an error, when no replica is configured", async () => {
    const w = setupWorld();
    cleanup.push(() => w.brain.close());
    expect(await replicaLine(w)).toMatchObject({ status: "disabled", detail: expect.stringContaining("No replica is configured") });
    expect((await health(w)).status).toBe("healthy");
  });

  it("reports replica lag: healthy when fresh, degraded then critical as the newest copy ages, and says what to check", async () => {
    const replica = temp("replica");
    const shipped = join(temp("shipped"), "shipped.json");
    const w = withEnv({ BRAIN_REPLICA_DIR: replica, BRAIN_REPLICA_SHIPPED_FILE: shipped, BRAIN_REPLICA_INTERVAL_SECONDS: "3600", BRAIN_REPLICA_WARN_SECONDS: "300", BRAIN_REPLICA_CRITICAL_SECONDS: "900" }, () => setupWorld());
    cleanup.push(() => w.brain.close());
    await w.brain.replicate();
    const snapshotAt = (JSON.parse(readFileSync(join(replica, "replica-status.json"), "utf8")) as { snapshotAtMs: number }).snapshotAtMs;
    // A snapshot exists locally but nothing has reached the second host yet.
    expect(await replicaLine(w)).toMatchObject({ status: "degraded", detail: expect.stringContaining("Nothing has reached the second host yet") });
    // The shipper reports a fresh copy: healthy, with the lag in words.
    writeFileSync(shipped, JSON.stringify({ shippedSnapshotAtMs: snapshotAt, shippedAtMs: snapshotAt }));
    expect(await replicaLine(w)).toMatchObject({ status: "healthy", detail: expect.stringMatching(/Replica lag is \d+ seconds/u) });
    expect((await health(w)).status).toBe("healthy");
    // The copy on the second host ages past the warning, then past the critical line: Health degrades and names the shipping timer.
    writeFileSync(shipped, JSON.stringify({ shippedSnapshotAtMs: snapshotAt - 10 * 60_000 }));
    expect(await replicaLine(w)).toMatchObject({ status: "degraded", detail: expect.stringContaining("Replica lag is 10 minutes") });
    expect((await health(w)).status).toBe("degraded");
    writeFileSync(shipped, JSON.stringify({ shippedSnapshotAtMs: snapshotAt - 40 * 60_000 }));
    const critical = await replicaLine(w);
    expect(critical).toMatchObject({ status: "unavailable", detail: expect.stringContaining("check the replica shipping on the host") });
    // The owner of an active workspace is told once, like for any bad probe.
    const notices = w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT title FROM attention_notifications WHERE item_id='platform:replica'").all() as Array<{ title: string }>;
    expect(notices.map((row) => row.title).join(" ")).toContain("The database replica is behind");
  });

  it("refuses a bad replica setting at startup instead of silently not replicating", () => {
    expect(() => withEnv({ BRAIN_REPLICA_DIR: temp("replica-bad"), BRAIN_REPLICA_WARN_SECONDS: "900", BRAIN_REPLICA_CRITICAL_SECONDS: "300" }, () => new Brain({ dataDir: temp("data-bad"), allowTestActor: true }))).toThrow(/CRITICAL_SECONDS must be larger/u);
  });
});

describe("restore from the replica", () => {
  it("rebuilds a working data directory on a copy: databases, artifacts and keys come back, suspended, and work after the snapshot does not", async () => {
    const replica = temp("replica-restore");
    const w = withEnv({ BRAIN_REPLICA_DIR: replica, BRAIN_REPLICA_INTERVAL_SECONDS: "3600" }, () => setupWorld());
    const digest = putBytes(w.brain.store, new TextEncoder().encode("evidence kept in the content-addressed store"));
    const kept = (await command(w, w.owner, "mission.create", "kept", { title: "Mission kept by the replica", intent: "Survive a failover", successCriteria: ["x"] })).resourceId ?? "";
    await w.brain.replicate();
    expect(JSON.parse(readFileSync(join(replica, "replica-status.json"), "utf8"))).toMatchObject({ files: expect.any(Number), casFilesCopied: expect.any(Number) });
    expect(existsSync(join(replica, "cas", digest.slice(7, 9), digest.slice(7)))).toBe(true);
    const lost = (await command(w, w.owner, "mission.create", "lost", { title: "Created after the last snapshot", intent: "Not replicated yet", successCriteria: ["x"] })).resourceId ?? "";
    const dataDir = w.brain.store.dataDir;
    const primaryKeys = readFileSync(join(dataDir, "authority.keys"));
    w.brain.close();

    // The primary is gone. Verify the replica and restore it into an empty directory, as the failover script does.
    const target = join(temp("failover"), "data");
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    let code: number;
    try { code = await runMaintenance(["restore-replica", replica, target]); } finally { process.stdout.write = write; }
    expect(code).toBe(0);
    const result = JSON.parse(out.join("")) as { restored: boolean; suspended: boolean; casFiles: number };
    expect(result).toMatchObject({ restored: true, suspended: true });
    expect(result.casFiles).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(target, "RESTORED-SUSPENDED.json"))).toBe(true);
    expect(readFileSync(join(target, "authority.keys")).equals(primaryKeys)).toBe(true);

    const restored = new Brain({ dataDir: target, allowTestActor: true });
    cleanup.push(() => restored.close());
    const ws = restored.store.workspaceDb(w.workspaceId, w.org);
    expect(ws.prepare("SELECT title FROM missions WHERE id=?").get(kept)).toEqual({ title: "Mission kept by the replica" });
    expect(ws.prepare("SELECT 1 FROM missions WHERE id=?").get(lost)).toBeUndefined();
    expect(new TextDecoder().decode(readVerified(restored.store, digest))).toBe("evidence kept in the content-addressed store");
    expect(restored.store.control.prepare("SELECT COUNT(*) AS n FROM organizations").get()).toEqual({ n: 1 });
  });

  it("refuses a tampered replica and restores nothing", async () => {
    const replica = temp("replica-tamper");
    const w = withEnv({ BRAIN_REPLICA_DIR: replica, BRAIN_REPLICA_INTERVAL_SECONDS: "3600" }, () => setupWorld());
    await w.brain.replicate();
    w.brain.close();
    const snapshot = join(replica, "snapshots", readdirSync(join(replica, "snapshots")).filter((entry) => entry.startsWith("snap-")).sort().at(-1)!);
    const file = join(snapshot, "control.db");
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("tampered")]));
    const target = join(temp("failover-bad"), "data");
    mkdirSync(join(target, ".."), { recursive: true });
    const err: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
    let code: number;
    try { code = await runMaintenance(["restore-replica", replica, target]); } finally { process.stderr.write = write; }
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/hash mismatch|integrity/u);
    expect(existsSync(target)).toBe(false);
  });
});
