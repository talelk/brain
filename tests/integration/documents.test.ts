import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt, Document, DocumentView, WorkBoardView } from "@brain/contracts";
import { sha256Digest } from "@brain/contracts";
import { setupWorld, type TestWorld } from "../helpers";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function world(): TestWorld {
  const w = setupWorld();
  cleanup.push(() => w.brain.close());
  return w;
}

function run(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>, actor: ActorContext = w.owner, expectedVersion?: number): CommandReceipt {
  return w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload,
  } as never, key).receipt;
}

function upload(w: TestWorld, key: string, text: string, title = "Operations guide"): string {
  return run(w, "document.upload", key, { title, fileName: "guide.md", mediaType: "text/markdown", bytesBase64: Buffer.from(text).toString("base64") }).resourceId!;
}

function detail(w: TestWorld, id: string): DocumentView {
  return (w.brain.executeQuery(w.owner, { queryType: "documents.get", workspaceId: w.workspaceId, resourceId: id }) as { snapshot: DocumentView }).snapshot;
}

function workItem(w: TestWorld): string {
  const objectiveId = run(w, "objective.create", "document-objective", { title: "Document-backed work", intent: "Use scoped resources", successCriteria: ["Verified"] }).resourceId!;
  const planId = run(w, "plan.propose", "document-plan", { objectiveId, origin: "manual", tasks: [{ id: "task", title: "Use the guide", criteria: ["verified"], dependsOn: [] }] }).resourceId!;
  run(w, "plan.confirm", "document-confirm", { planVersionId: planId }, w.owner, 1);
  const board = (w.brain.executeQuery(w.owner, { queryType: "workBoard.get", workspaceId: w.workspaceId }) as { snapshot: WorkBoardView }).snapshot;
  return board.items[0]!.workItemId;
}

describe("workspace documents and immutable versions (T54, E107)", () => {
  it("stores immutable bytes, previews text safely, associates and indexes only the current revision", () => {
    const w = world();
    const firstText = "# Guide\n<script>alert('not html')</script>\nold-unique-token";
    const id = upload(w, "upload-first", firstText);
    const first = detail(w, id);
    const firstBytes = new TextEncoder().encode(firstText);
    expect(first.document).toEqual(expect.objectContaining({ documentId: id, state: "active", version: 1, currentVersionId: first.versions[0]!.documentVersionId }));
    expect(first.preview).toEqual({ kind: "text", text: firstText, truncated: false });
    expect(first.versions[0]).toEqual(expect.objectContaining({ revision: 1, digest: sha256Digest(firstBytes), extractionStatus: "ready" }));

    const secondText = "# Guide\nnew-unique-token";
    const secondVersionId = run(w, "document.revise", "revise-second", { documentId: id, title: "Operations guide", fileName: "guide-v2.md", mediaType: "text/markdown", bytesBase64: Buffer.from(secondText).toString("base64") }, w.owner, 1).resourceId!;
    const second = detail(w, id);
    expect(second.document.version).toBe(2);
    expect(second.document.currentVersionId).toBe(secondVersionId);
    expect(second.versions.map((version) => version.revision)).toEqual([2, 1]);
    expect(second.versions[1]!.digest).toBe(first.versions[0]!.digest);
    expect(second.preview).toEqual({ kind: "text", text: secondText, truncated: false });

    const item = workItem(w);
    const associationId = run(w, "document.associate", "associate-work", { documentId: id, resource: { kind: "workItem", id: item } }).resourceId!;
    expect(detail(w, id).associations).toEqual([expect.objectContaining({ associationId, resourceKind: "workItem", resourceId: item })]);
    const found = (w.brain.executeQuery(w.owner, { queryType: "documents.search", workspaceId: w.workspaceId, search: "new-unique-token" }) as { snapshot: { items: Document[] } }).snapshot.items;
    expect(found.map((document) => document.documentId)).toEqual([id]);
    const old = (w.brain.executeQuery(w.owner, { queryType: "documents.search", workspaceId: w.workspaceId, search: "old-unique-token" }) as { snapshot: { items: Document[] } }).snapshot.items;
    expect(old).toEqual([]);
    expect(w.brain.store.workspaceDb(w.workspaceId, w.org).prepare("SELECT COUNT(*) AS n FROM memory_publications").get()).toEqual({ n: 0 });
  });

  it("revokes search and further mutation while preserving immutable history", () => {
    const w = world();
    const id = upload(w, "upload-revoke", "revocable-content");
    run(w, "document.delete", "revoke-document", { documentId: id, reason: "Superseded and no longer approved" }, w.owner, 1);
    expect(detail(w, id).document.state).toBe("revoked");
    expect(detail(w, id).versions).toHaveLength(1);
    const listed = (w.brain.executeQuery(w.owner, { queryType: "documents.list", workspaceId: w.workspaceId }) as { snapshot: { items: Document[] } }).snapshot.items;
    expect(listed).toEqual([]);
    const found = (w.brain.executeQuery(w.owner, { queryType: "documents.search", workspaceId: w.workspaceId, search: "revocable-content" }) as { snapshot: { items: Document[] } }).snapshot.items;
    expect(found).toEqual([]);
    expect(() => run(w, "document.revise", "revise-revoked", { documentId: id, title: "No", fileName: "no.txt", mediaType: "text/plain", bytesBase64: Buffer.from("no").toString("base64") })).toThrow(/revoked/i);
    expect(() => run(w, "document.delete", "revoke-stale", { documentId: id, reason: "Stale" }, w.owner, 1)).toThrow(/expected version/i);
  });

  it("offers download-only preview for binary documents without indexing their bytes", () => {
    const w = world();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const id = run(w, "document.upload", "upload-binary", { title: "Binary guide", fileName: "guide.pdf", mediaType: "application/pdf", bytesBase64: Buffer.from(bytes).toString("base64") }).resourceId!;
    const current = detail(w, id);
    expect(current.preview).toEqual({ kind: "download-only" });
    expect(current.versions[0]!.extractionStatus).toBe("unsupported");
    const found = (w.brain.executeQuery(w.owner, { queryType: "documents.search", workspaceId: w.workspaceId, search: "Binary guide" }) as { snapshot: { items: Document[] } }).snapshot.items;
    expect(found.map((document) => document.documentId)).toEqual([id]);
  });

  it("retains every immutable document version during CAS garbage collection", () => {
    const w = world();
    const id = upload(w, "upload-cas", "first-cas-version");
    run(w, "document.revise", "revise-cas", { documentId: id, title: "Operations guide", fileName: "guide-v2.md", mediaType: "text/markdown", bytesBase64: Buffer.from("second-cas-version").toString("base64") }, w.owner, 1);
    const before = detail(w, id).versions.map((version) => version.digest);
    expect(w.brain.casSweep(0).scanned).toBeGreaterThan(0);
    expect(detail(w, id).versions.map((version) => version.digest)).toEqual(before);
  });
});
