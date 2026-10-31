import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, ConfigurationDraft, DraftRevision, PublicationProposal } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { setupWorld, type TestWorld } from "../helpers";
import { createGitHttpBackend } from "../support/git-http-backend";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function run(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): CommandReceipt {
  return w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload,
  } as never, key).receipt;
}

describe("configuration Studio publication pipeline (T56, E109)", () => {
  it("validates immutable revisions, publishes the exact Git commit and requires separate activation", async () => {
    const remote = await createGitHttpBackend();
    cleanup.push(remote.cleanup);
    const dir = mkdtempSync(join(tmpdir(), "brain-studio-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const activeBefore = w.brain.activeRelease(w.org)!.digest;
    const draftId = run(w, "configDraft.create", "create-draft", { title: "Studio Workflow", kind: "Workflow" }).resourceId!;
    expect(run(w, "configDraft.validate", "validate-draft", { draftId }).accepted).toBe(true);
    const validation = w.brain.store.control.prepare("SELECT status FROM validation_runs WHERE draft_id=?").get(draftId) as { status: string };
    expect(validation.status).toBe("passed");
    const detail = w.brain.executeQuery(w.owner, { queryType: "configDrafts.get", workspaceId: w.workspaceId, resourceId: draftId }) as { snapshot: { revisions: DraftRevision[]; impact: { changedDefinitions: unknown[] } } };
    expect(detail.snapshot.revisions).toHaveLength(1);
    expect(detail.snapshot.revisions[0]!.documents[0]!.text).toContain("spec:\n  jobs:");
    expect(detail.snapshot.impact.changedDefinitions.length).toBeGreaterThan(0);

    const connectionId = run(w, "integration.connect", "studio-connect", { name: "Studio remote", repositoryUrl: remote.remote }).resourceId!;
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    const bindingId = run(w, "integration.bind", "studio-bind", { connectionId, workspaceId: w.workspaceId, kind: "configuration", repositoryKey: remote.remote, access: "write" }).resourceId!;
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    const publicationId = run(w, "configDraft.publish", "publish-draft", { draftId, bindingId }, 2).resourceId!;
    expect(await w.brain.drafts.publishPending()).toEqual({ published: 1, failed: 0 });
    const publication = w.brain.store.control.prepare("SELECT * FROM publication_requests WHERE id=?").get(publicationId) as { state: string; commit_oid: string; release_digest: string };
    expect(publication.state).toBe("compiled");
    expect(publication.commit_oid).toMatch(/^[0-9a-f]{40}$/);
    expect(w.brain.activeRelease(w.org)!.digest).toBe(activeBefore);
    const staged = w.brain.inspectRelease(w.owner, publication.release_digest) as { sourceRevision: string };
    expect(staged.sourceRevision).toBe(`sha1:${publication.commit_oid}`);
    const committed = w.brain.store.control.prepare("SELECT source_documents_json FROM config_releases WHERE digest=?").get(publication.release_digest) as { source_documents_json: string };
    expect(JSON.parse(committed.source_documents_json)).toEqual(detail.snapshot.revisions[0]!.documents);

    run(w, "config.activate", "activate-studio", { configDigest: publication.release_digest, expectedActiveDigest: activeBefore });
    expect(w.brain.activeRelease(w.org)!.digest).toBe(publication.release_digest);
    const publishedDraft = w.brain.executeQuery(w.owner, { queryType: "configDrafts.get", workspaceId: w.workspaceId, resourceId: draftId }) as { snapshot: { draft: ConfigurationDraft; publications: PublicationProposal[] } };
    expect(publishedDraft.snapshot.draft.state).toBe("published");
    expect(publishedDraft.snapshot.publications[0]).toEqual(expect.objectContaining({ state: "compiled", commitOid: publication.commit_oid, releaseDigest: publication.release_digest }));
  });
});
