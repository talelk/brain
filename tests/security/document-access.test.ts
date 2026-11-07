import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, DocumentView } from "@brain/contracts";
import { seedHuman, setupWorld, type TestWorld } from "../helpers";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function world(): TestWorld {
  const w = setupWorld();
  cleanup.push(() => w.brain.close());
  return w;
}

async function run(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>, actor: ActorContext = w.owner): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    workspaceId: w.workspaceId, idempotencyKey: key, payload,
  } as never, key)).receipt;
}

function input(title = "Scoped document"): Record<string, unknown> {
  return { title, fileName: "scope.txt", mediaType: "text/plain", bytesBase64: Buffer.from("workspace-only-content").toString("base64") };
}

async function upload(w: TestWorld, key = "secure-upload"): Promise<string> {
  return (await run(w, "document.upload", key, input())).resourceId!;
}

describe("document authorization and safe intake (T54, E107)", () => {
  it("denies cross-tenant identifiers and read-only or agent mutation", async () => {
    const w = world();
    const id = await upload(w);
    const outsider = { ...w.owner, actorId: "outsider", organizationId: "org-other" };
    await expect(Promise.resolve().then(() => w.brain.executeQuery(outsider, { queryType: "documents.get", workspaceId: w.workspaceId, resourceId: id }))).rejects.toThrow(/workspace not found/i);
    await expect(Promise.resolve().then(async () => await run(w, "document.upload", "outsider-upload", input(), outsider))).rejects.toThrow(/workspace not found/i);

    seedHuman(w.brain, w.org, "viewer-1");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id,organization_id,principal_id,role,version,granted_by,granted_at_ms) VALUES (?,?,'viewer-1','viewer',1,'owner-1',?)").run(w.workspaceId, w.org, w.brain.store.now());
    const viewer = w.actor("viewer-1", w.workspaceId);
    expect(((await w.brain.executeQuery(viewer, { queryType: "documents.get", workspaceId: w.workspaceId, resourceId: id })) as { snapshot: DocumentView }).snapshot.document.documentId).toBe(id);
    await expect(Promise.resolve().then(async () => await run(w, "document.upload", "viewer-upload", input(), viewer))).rejects.toThrow(/missing scope/i);
    const agent = { ...w.owner, kind: "agent" as const, actorId: "document-agent" };
    await expect(Promise.resolve().then(async () => await run(w, "document.delete", "agent-delete", { documentId: id, reason: "Agents cannot revoke" }, agent))).rejects.toThrow(/actor kind/i);
  });

  it("rejects malformed names, base64, text encoding, unsupported media and foreign associations", async () => {
    const w = world();
    await expect(Promise.resolve().then(async () => await run(w, "document.upload", "path-name", { ...input(), fileName: "../secret.txt" }))).rejects.toThrow(/plain file name|additional properties/i);
    await expect(Promise.resolve().then(async () => await run(w, "document.upload", "bad-base64", { ...input(), bytesBase64: "not base64" }))).rejects.toThrow(/base64|additional properties/i);
    await expect(Promise.resolve().then(async () => await run(w, "document.upload", "bad-utf8", { ...input(), bytesBase64: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64") }))).rejects.toThrow(/UTF-8/i);
    await expect(Promise.resolve().then(async () => await run(w, "document.upload", "active-content", { ...input(), mediaType: "image/svg+xml" }))).rejects.toThrow(/mediaType|additional properties/i);
    const id = await upload(w, "association-upload");
    await expect(Promise.resolve().then(async () => await run(w, "document.associate", "foreign-association", { documentId: id, resource: { kind: "workItem", id: "work-other-workspace" } }))).rejects.toThrow(/target not found/i);
  });

  it("does not allow associations or search to bypass revocation", async () => {
    const w = world();
    const id = await upload(w, "revocation-upload");
    await run(w, "document.delete", "revocation-delete", { documentId: id, reason: "Access retired" });
    await expect(Promise.resolve().then(async () => await run(w, "document.associate", "revoked-association", { documentId: id, resource: { kind: "mission", id: "objective-missing" } }))).rejects.toThrow(/revoked/i);
    const result = (await w.brain.executeQuery(w.owner, { queryType: "documents.search", workspaceId: w.workspaceId, search: "workspace-only-content" })) as { snapshot: { items: unknown[] } };
    expect(result.snapshot.items).toEqual([]);
  });
});
