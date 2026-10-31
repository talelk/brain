import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { it, expect } from "vitest";
import { Brain } from "../../apps/governor/src/application/brain";

it("initializes a useful workspace once and preserves customization on restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-first-launch-"));
  const dataDir = join(root, "data");
  const env = { ...process.env, BRAIN_DATA_DIR: dataDir, BRAIN_CLI_STATE_DIR: join(root, "cli"), BRAIN_GOVERNOR_URL: "http://127.0.0.1:3100", BRAIN_BASE_URL: "http://127.0.0.1:3100" };
  const initialize = () => spawnSync(process.execPath, ["--import", "tsx", "scripts/initialize-local.ts"], { env, encoding: "utf8", timeout: 30000 });
  try {
    const first = initialize();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("admin@brain.local");
    expect(first.stdout).toContain("admin-password");
    expect(existsSync(join(dataDir, "initial-admin-password"))).toBe(false);
    const state = JSON.parse(readFileSync(join(dataDir, "first-launch.json"), "utf8"));
    expect(state.completed).toBe(true);
    const brain = new Brain({ dataDir });
    await brain.auth.ready();
    let digest: string;
    try {
      expect(brain.store.control.prepare("SELECT email FROM user").all()).toEqual([{ email: "admin@brain.local" }]);
      const login = await brain.auth.bootstrapAccount({ email: "admin@brain.local", password: "admin-password", name: "Administrator" });
      expect((await brain.auth.readSession(new Headers({ authorization: `Bearer ${login.token}` })))?.passwordChangeRequired).toBe(false);
      const active = brain.store.control.prepare("SELECT release_digest FROM active_config").get() as { release_digest: string };
      digest = active.release_digest;
      const release = brain.store.control.prepare("SELECT manifest_json FROM config_releases WHERE digest=?").get(digest) as { manifest_json: string };
      const manifest = JSON.parse(release.manifest_json);
      expect(Object.keys(manifest.workflows)).toEqual(expect.arrayContaining(["operations-triage", "support-draft"]));
      expect(manifest.tools.map((tool: { id: string }) => tool.id)).toEqual(expect.arrayContaining(["operations.context", "operations.validate"]));
      brain.store.control.prepare("UPDATE workspaces SET slug='Personalized workspace' WHERE id=?").run(state.workspaceId);
    } finally { brain.close(); }
    // Simulate a crash after all resources committed but before completion was recorded.
    writeFileSync(join(dataDir, "first-launch.json"), JSON.stringify({ ...state, completed: false }));
    const second = initialize();
    expect(second.status, second.stderr).toBe(0);
    expect(existsSync(join(dataDir, "initial-admin-password"))).toBe(false);
    const restarted = new Brain({ dataDir });
    await restarted.auth.ready();
    try {
      expect(restarted.store.control.prepare("SELECT slug FROM workspaces").all()).toEqual([{ slug: "Personalized workspace" }]);
      expect(restarted.store.control.prepare("SELECT release_digest FROM active_config").get()).toEqual({ release_digest: digest });
      expect(restarted.store.control.prepare("SELECT COUNT(*) AS n FROM user").get()).toEqual({ n: 1 });
      expect(existsSync(join(dataDir, "first-launch.json"))).toBe(true);
    } finally { restarted.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60000);
