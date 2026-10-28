import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../apps/governor/src/application/store";
import { engineHealth } from "../../apps/governor/src/infrastructure/persistence/open";

// T04: fresh current-schema initialization, exact schema checks (control AND
// workspace DBs), engine health, and the bounded workspace-handle LRU under
// many-workspace churn.
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* already closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env["BRAIN_MAX_WORKSPACE_DBS"];
});

function freshStore(maxWs?: number): { store: Store; dir: string } {
  if (maxWs) process.env["BRAIN_MAX_WORKSPACE_DBS"] = String(maxWs);
  const dir = mkdtempSync(join(tmpdir(), "brain-storage-"));
  dirs.push(dir);
  const store = new Store({ dataDir: dir });
  stores.push(store);
  return { store, dir };
}

describe("storage initialization and bounds (T04)", () => {
  it("opens with WAL/FULL/foreign-keys pragmas and a WAL-safe engine", () => {
    const { store } = freshStore();
    expect(store.control.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(store.control.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(store.control.pragma("synchronous", { simple: true })).toBe(2); // FULL
    const health = engineHealth(store.control);
    expect(health.walSafe).toBe(true);
    expect(health.fts5).toBe(true);
  });

  it("workspace DBs are identity- and digest-checked on reopen; tamper is refused, not converted", () => {
    const { store, dir } = freshStore();
    const ws = store.workspaceDb("ws-1", "org-1");
    ws.prepare("INSERT INTO cards(id, title, state, criteria_json, created_at_ms) VALUES ('c1','t','todo','[\"x\"]',?)").run(Date.now());
    expect(() => store.workspaceDb("ws-1", "org-other")).toThrow(/mismatch/);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new Store({ dataDir: dir });
    stores.push(reopened);
    const again = reopened.workspaceDb("ws-1", "org-1");
    expect(again.prepare("SELECT title FROM cards WHERE id='c1'").get()).toEqual({ title: "t" });
    // Tamper with the stored digest: exact check must refuse the DB.
    again.prepare("UPDATE workspace_identity SET schema_digest='sha256:deadbeef' WHERE singleton=1").run();
    reopened.close();
    stores.splice(stores.indexOf(reopened), 1);
    const third = new Store({ dataDir: dir });
    stores.push(third);
    expect(() => third.workspaceDb("ws-1", "org-1")).toThrow(/does not match current target/);
  });

  it("LRU keeps at most the configured handles across 48 workspaces; data survives eviction", () => {
    const { store } = freshStore(8);
    const t0 = Date.now();
    for (let i = 0; i < 48; i++) {
      const ws = store.workspaceDb(`ws-${i}`, "org-1");
      ws.prepare("INSERT INTO cards(id, title, state, criteria_json, created_at_ms) VALUES (?,?,'todo','[\"x\"]',?)").run(`c-${i}`, `card-${i}`, Date.now());
      expect(store.openWorkspaceCount()).toBeLessThanOrEqual(8);
    }
    const churnMs = Date.now() - t0;
    // Evicted workspaces reopen transparently with their data intact.
    for (const i of [0, 7, 23, 47]) {
      const ws = store.workspaceDb(`ws-${i}`, "org-1");
      expect(ws.prepare("SELECT title FROM cards WHERE id=?").get(`c-${i}`)).toEqual({ title: `card-${i}` });
    }
    expect(store.openWorkspaceCount()).toBeLessThanOrEqual(8);
    expect(churnMs).toBeLessThan(30_000);
  }, 120_000);
});
