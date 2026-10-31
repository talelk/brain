import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { seedHuman, setupWorld, type TestWorld } from "../helpers";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function run(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>, actor: ActorContext = w.owner): CommandReceipt {
  return w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    workspaceId: w.workspaceId, idempotencyKey: key, payload,
  } as never, key).receipt;
}

describe("configuration Studio authorization (T56, E109)", () => {
  it("requires current configuration rights, valid revisions and tenant-local draft access", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-studio-security-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const noScopes = { ...w.owner, scopes: ["workspace:read"] };
    expect(() => run(w, "configDraft.create", "denied-create", { title: "Denied" }, noScopes)).toThrow(/missing scope/i);
    const draftId = run(w, "configDraft.create", "create-unvalidated", { title: "Unvalidated" }).resourceId!;
    expect(() => run(w, "configDraft.publish", "publish-unvalidated", { draftId, bindingId: "missing-binding" })).toThrow(/must pass validation|binding/i);
    const outsider = { ...w.owner, organizationId: "org-other" };
    expect(() => w.brain.executeQuery(outsider, { queryType: "configDrafts.get", workspaceId: w.workspaceId, resourceId: draftId })).toThrow(/workspace not found/i);

    seedHuman(w.brain, w.org, "viewer-studio");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES (?,?,'viewer-studio','viewer',1,'owner-1',?)").run(w.workspaceId, w.org, w.brain.store.now());
    const viewer = w.actor("viewer-studio", w.workspaceId);
    expect(() => run(w, "configDraft.update", "viewer-update", { draftId, documents: [{ path: "workflows/x.yaml", text: "apiVersion: brain.keyrus/v1\nkind: Workflow\nmetadata:\n  id: x\nspec:\n  jobs:\n    echo:\n      kind: dispatch\n      needs: []\n" }] }, viewer)).toThrow(/missing scope/i);
  });

  it("keeps invalid advanced YAML out of the publication path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-studio-yaml-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const draftId = run(w, "configDraft.create", "create-yaml", { title: "Unsafe workflow" }).resourceId!;
    run(w, "configDraft.update", "update-yaml", { draftId, documents: [{ path: "workflows/unsafe.yaml", text: "apiVersion: brain.keyrus/v1\nkind: Workflow\nmetadata:\n  id: unsafe\nspec:\n  nodes:\n    echo:\n      kind: dispatch\n" }] });
    run(w, "configDraft.validate", "validate-yaml", { draftId });
    expect((w.brain.store.control.prepare("SELECT status FROM validation_runs WHERE draft_id=?").get(draftId) as { status: string }).status).toBe("failed");
    expect(() => run(w, "configDraft.publish", "publish-yaml", { draftId, bindingId: "missing-binding" })).toThrow(/must pass validation/i);
  });
});
