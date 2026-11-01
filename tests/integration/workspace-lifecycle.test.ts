import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/governor/src/http/app";
import { DIGEST_A, setupWorld, type TestWorld } from "../helpers";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function run(w: TestWorld, key: string, commandType: "workspace.update" | "workspace.control", payload: Record<string, unknown>, expectedVersion: number) {
  return w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: key, idempotencyKey: key, commandType,
    workspaceId: w.workspaceId, expectedVersion, payload,
  }, key).receipt;
}

function insertJob(w: TestWorld, state: "queued" | "outcome_unknown") {
  const now = w.brain.store.now();
  w.brain.store.control.prepare(`INSERT INTO jobs(id,organization_id,workspace_id,execution_key,workflow_run_id,step_id,state,config_digest,placement_json,execution_digest,effect_class,created_at_ms,ready_at_ms,deadline_ms)
    VALUES ('job-workspace-lifecycle',?,?,'job-workspace-lifecycle','run-workspace-lifecycle','step',?,?,'{}',?,'read',?,?,?)`)
    .run(w.org, w.workspaceId, state, w.brain.activeRelease(w.org)!.digest, DIGEST_A, now, now, now + 60_000);
}

describe("workspace metadata and operational lifecycle", () => {
  it("uses expected versions and validates suspend, resume and archive transitions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-workspace-lifecycle-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    w.brain.createWorkspace(w.owner, { workspaceId: "ws-metadata", slug: "Metadata workspace", description: "Scoped operations", ownerId: "owner-1", tags: ["support", "local"] });
    expect(w.brain.store.control.prepare("SELECT description,owner_id,tags_json FROM workspaces WHERE id='ws-metadata'").get()).toEqual({ description: "Scoped operations", owner_id: "owner-1", tags_json: '["support","local"]' });

    expect(run(w, "update-workspace", "workspace.update", { workspaceId: w.workspaceId, displayName: "Governed workspace", description: "Production support", ownerId: "owner-1", tags: ["support"] }, 1).accepted).toBe(true);
    expect(() => run(w, "update-stale", "workspace.update", { workspaceId: w.workspaceId, displayName: "Stale overwrite", description: "", ownerId: "owner-1", tags: [] }, 1)).toThrow();
    expect(run(w, "suspend-workspace", "workspace.control", { workspaceId: w.workspaceId, action: "suspend", reason: "Planned operational pause" }, 2).accepted).toBe(true);
    insertJob(w, "outcome_unknown");
    expect(() => run(w, "resume-unresolved", "workspace.control", { workspaceId: w.workspaceId, action: "resume", reason: "Attempt unsafe resume" }, 3)).toThrow(/reconcile unknown outcomes/);
    w.brain.store.control.prepare("DELETE FROM jobs WHERE id='job-workspace-lifecycle'").run();
    expect(run(w, "resume-workspace", "workspace.control", { workspaceId: w.workspaceId, action: "resume", reason: "Configuration and outcomes checked" }, 3).accepted).toBe(true);
    insertJob(w, "queued");
    expect(() => run(w, "archive-active", "workspace.control", { workspaceId: w.workspaceId, action: "archive", reason: "Attempt early archive" }, 4)).toThrow(/requires no active/);
    w.brain.store.control.prepare("DELETE FROM jobs WHERE id='job-workspace-lifecycle'").run();
    expect(run(w, "archive-workspace", "workspace.control", { workspaceId: w.workspaceId, action: "archive", reason: "Retained for audit" }, 4).accepted).toBe(true);

    const bridge = w.brain.executeQuery(w.owner, { queryType: "bridge" }) as { snapshot: { items: Array<{ displayName: string; description: string; tags: string[]; status: string; version: number }> } };
    expect(bridge.snapshot.items.find((workspace) => workspace.displayName === "Governed workspace")).toMatchObject({ description: "Production support", tags: ["support"], status: "archived", version: 5 });
  });
});
