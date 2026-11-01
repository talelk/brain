import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, ConfigurationDraft, DraftRevision, PublicationProposal } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { goldenDocs, setupWorld, type TestWorld } from "../helpers";
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
    const committedDocuments = JSON.parse(committed.source_documents_json) as Array<{ path: string; text: string }>;
    expect(committedDocuments).toEqual(expect.arrayContaining([...detail.snapshot.revisions[0]!.documents]));
    expect(committedDocuments.length).toBeGreaterThan(detail.snapshot.revisions[0]!.documents.length);

    run(w, "config.activate", "activate-studio", { configDigest: publication.release_digest, expectedActiveDigest: activeBefore });
    expect(w.brain.activeRelease(w.org)!.digest).toBe(publication.release_digest);
    const publishedDraft = w.brain.executeQuery(w.owner, { queryType: "configDrafts.get", workspaceId: w.workspaceId, resourceId: draftId }) as { snapshot: { draft: ConfigurationDraft; publications: PublicationProposal[] } };
    expect(publishedDraft.snapshot.draft.state).toBe("published");
    expect(publishedDraft.snapshot.publications[0]).toEqual(expect.objectContaining({ state: "compiled", commitOid: publication.commit_oid, releaseDigest: publication.release_digest }));

    const agentDraftId = run(w, "configDraft.create", "create-agent", { title: "Reviewed Agent", kind: "Agent" }).resourceId!;
    expect(run(w, "configDraft.validate", "validate-agent", { draftId: agentDraftId }).accepted).toBe(true);
    const agentDraft = w.brain.executeQuery(w.owner, { queryType: "configDrafts.get", workspaceId: w.workspaceId, resourceId: agentDraftId }) as { snapshot: { revisions: DraftRevision[] } };
    expect(agentDraft.snapshot.revisions[0]!.assets[0]).toMatchObject({ path: "agents/reviewed-agent.md" });
    run(w, "configDraft.publish", "publish-agent", { draftId: agentDraftId, bindingId }, 2);
    expect(await w.brain.drafts.publishPending()).toEqual({ published: 1, failed: 0 });
    const agentPublication = w.brain.store.control.prepare("SELECT release_digest FROM publication_requests WHERE draft_id=?").get(agentDraftId) as { release_digest: string };
    const agentRelease = w.brain.inspectRelease(w.owner, agentPublication.release_digest) as { manifest: { documents: Array<{ kind: string; id: string }> } };
    expect(agentRelease.manifest.documents).toContainEqual(expect.objectContaining({ kind: "Agent", id: "reviewed-agent" }));
  });

  it("clones an active Agent with independent instructions and validates both edit and duplicate candidates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-agent-studio-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const agentDocument = {
      path: "config/candidate-agent.yaml",
      text: "apiVersion: brain.keyrus/v1\nkind: Agent\nmetadata:\n  id: candidate-agent\n  version: 1.0.0\nspec:\n  instructionsPath: agents/candidate.md\n  tools: []\n  engine:\n    anyOf: [pi]\n    features: [start, events, cancel]\n  maxTurns: 5\n  maxChildren: 0\n  maxDepth: 0\n  maxTokens: 1000\n  maxMicroUsd: 0\n",
    };
    const release = w.brain.stageRelease(w.owner, [...goldenDocs(), agentDocument], "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4", [], [{ agentId: "candidate-agent", path: "agents/candidate.md", text: "# Original instructions\n" }]);
    w.brain.activateRelease(w.owner, release.digest);
    const editId = run(w, "configDraft.create", "clone-edit", { title: "Candidate Agent", kind: "Agent", sourceDefinition: { kind: "Agent", id: "candidate-agent", mode: "edit" } }).resourceId!;
    const duplicateId = run(w, "configDraft.create", "clone-duplicate", { title: "Copied Agent", kind: "Agent", sourceDefinition: { kind: "Agent", id: "candidate-agent", mode: "duplicate" } }).resourceId!;
    expect(run(w, "configDraft.validate", "validate-edit", { draftId: editId }).accepted).toBe(true);
    expect(run(w, "configDraft.validate", "validate-duplicate", { draftId: duplicateId }).accepted).toBe(true);
    const duplicate = w.brain.executeQuery(w.owner, { queryType: "configDrafts.get", workspaceId: w.workspaceId, resourceId: duplicateId }) as { snapshot: { revisions: DraftRevision[] } };
    expect(duplicate.snapshot.revisions[0]!.documents[0]!.text).toContain("id: copied-agent");
    expect(duplicate.snapshot.revisions[0]!.documents[0]!.text).toContain("instructionsPath: agents/copied-agent.md");
    expect(duplicate.snapshot.revisions[0]!.assets).toEqual([{ path: "agents/copied-agent.md", text: "# Original instructions\n" }]);
    expect(w.brain.activeRelease(w.org)!.digest).toBe(release.digest);
  });
});
