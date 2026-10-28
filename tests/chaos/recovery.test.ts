import { seedOrganization } from "../helpers";
import { describe, expect, it } from "vitest";
import { setupWorld, tempBrain } from "../helpers";
import { Brain } from "../../apps/governor/src/application/brain";
import { createBackup, restoreBackup, verifyBackup } from "../../apps/governor/src/modules/operations/index";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("chaos / recovery", () => {
  it("same-version restart preserves board and approvals (T04/G07 partial)", async () => {
    const w = setupWorld();
    w.brain.executeCommand(w.owner, {
      contractVersion: "brain.command/v1", commandId: "cmd-r1", commandType: "board.create",
      workspaceId: w.workspaceId, idempotencyKey: "kr-1", payload: { title: "Survive restart", criteria: ["ok"] },
    }, "c1");
    w.brain.close();
    const reopened = new Brain({ dataDir: w.dir, allowTestActor: true });
    const ws = reopened.store.workspaceDb(w.workspaceId, w.org);
    const row = ws.prepare("SELECT title FROM cards").get() as { title: string };
    expect(row.title).toBe("Survive restart");
    reopened.close();
  });

  it("backup verifies hashes and restore refuses non-empty destination (E088)", async () => {
    const w = setupWorld();
    w.brain.close();
    const backupDir = mkdtempSync(join(tmpdir(), "brain-backup-"));
    const manifest = await createBackup(w.dir, backupDir);
    // Local mode archives everything (memory in control.db, Mastra LibSQL,
    // authority watermarks); only a configured remote TencentDB stays out.
    expect(manifest.completeness).toBe(process.env["BRAIN_TENCENTDB_URL"] ? "partial" : "complete");
    expect(verifyBackup(backupDir).files.length).toBeGreaterThan(0);
    const into = mkdtempSync(join(tmpdir(), "brain-restore-"));
    restoreBackup(backupDir, into);
    expect(() => restoreBackup(backupDir, into)).toThrow();
  });

  it("outbox projection is idempotent under redelivery (E085)", async () => {
    const { brain } = tempBrain();
    seedOrganization(brain, { organizationId: "org-ob", ownerId: "owner-ob" });
    brain.store.control.prepare("INSERT INTO organizations(id, auth_organization_id) VALUES ('org-ob2','org-ob2') ON CONFLICT DO NOTHING").run();
    brain.projectOutbox();
    const first = brain.projectOutbox();
    const second = brain.projectOutbox();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBe(0);
    brain.close();
  });
});
