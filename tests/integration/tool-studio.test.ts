import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, DraftRevision } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { setupWorld, type TestWorld } from "../helpers";
import { createGitHttpBackend } from "../support/git-http-backend";
import { fixtureStarter } from "../support/starter";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function run(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>, expectedVersion?: number): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    workspaceId: w.workspaceId, idempotencyKey: key, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload,
  } as never, key)).receipt;
}

describe("editing a tool in Studio", () => {
  it("edits a tool's definition and script, re-pins the agents that use it, and keeps every other tool's script", async () => {
    const remote = await createGitHttpBackend();
    cleanup.push(remote.cleanup);
    const dir = mkdtempSync(join(tmpdir(), "brain-tool-studio-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const bundle = fixtureStarter();
    const release = w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas);
    w.brain.activateRelease(w.owner, release.digest);
    const scriptOf = (digest: string, toolId: string) => w.brain.store.control.prepare("SELECT digest FROM release_files WHERE release_digest=? AND tool_id=?").get(digest, toolId) as { digest: string };

    const draftId = (await run(w, "configDraft.create", "tool-edit", { title: "Edit csv.query", kind: "Tool", sourceDefinition: { kind: "Tool", id: "csv.query", mode: "edit" } })).resourceId!;
    const detail = async () => ((await w.brain.executeQuery(w.owner, { queryType: "configDrafts.get", workspaceId: w.workspaceId, resourceId: draftId })) as unknown as { snapshot: { revisions: DraftRevision[]; draft: { version: number }; validations: Array<{ status: string }> } }).snapshot;
    const first = (await detail()).revisions[0]!;
    // The draft carries the definition, its own script and both schemas, and nothing of any other tool.
    expect(first.documents).toHaveLength(1);
    expect(first.assets.map((asset) => asset.path).sort()).toEqual(["schemas/csv-query-input.json", "schemas/csv-query-output.json", "tools/csv.query/run.sh"]);

    const script = first.assets.find((asset) => asset.path === "tools/csv.query/run.sh")!;
    const definition = first.documents[0]!;
    const edited = await run(w, "configDraft.update", "tool-update", {
      draftId, source: "yaml",
      documents: [{ path: definition.path, text: definition.text.replace(/"description": "[^"]*"/u, '"description": "Reads rows from one verified CSV file (edited)"') }],
      assets: first.assets.map((asset) => asset === script ? { path: asset.path, text: `${asset.text}\n# edited in Studio\n` } : asset),
    }, (await detail()).draft.version);
    expect(edited.accepted).toBe(true);
    expect((await run(w, "configDraft.validate", "tool-validate", { draftId })).accepted).toBe(true);
    expect((await detail()).validations[0]!.status).toBe("passed");

    const connectionId = (await run(w, "integration.connect", "tool-connect", { name: "Tool remote", repositoryUrl: remote.remote })).resourceId!;
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    const bindingId = (await run(w, "integration.bind", "tool-bind", { connectionId, workspaceId: w.workspaceId, kind: "configuration", repositoryKey: remote.remote, access: "write" })).resourceId!;
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    await run(w, "configDraft.publish", "tool-publish", { draftId, bindingId }, (await detail()).draft.version);
    expect(await w.brain.drafts.publishPending()).toEqual({ published: 1, failed: 0 });
    const staged = (w.brain.store.control.prepare("SELECT release_digest FROM publication_requests WHERE draft_id=?").get(draftId) as { release_digest: string }).release_digest;

    // The new release is a different one with the edited script; every other tool kept its own script (not the first run.sh found).
    expect(staged).not.toBe(release.digest);
    expect(scriptOf(staged, "csv.query").digest).not.toBe(scriptOf(release.digest, "csv.query").digest);
    for (const toolId of ["documents.read", "host.exec", "host.read", "web.fetch", "knowledge.search"]) expect(scriptOf(staged, toolId).digest).toBe(scriptOf(release.digest, toolId).digest);
    // Agents that list the tool follow its new definition digest.
    const toolDigest = (id: string, digest: string) => ((w.brain.inspectRelease(w.owner, digest) as unknown as { manifest: { tools: Array<{ id: string; digest: string }> } }).manifest.tools.find((tool) => tool.id === id)!.digest);
    expect(toolDigest("csv.query", staged)).not.toBe(toolDigest("csv.query", release.digest));
    const agentTools = (digest: string) => ((w.brain.inspectRelease(w.owner, digest) as unknown as { agents: Record<string, { spec: { tools: Array<{ id: string; digest: string }> } }> }).agents["task-worker"]!.spec.tools.find((tool) => tool.id === "csv.query")!.digest);
    expect(agentTools(staged)).toBe(toolDigest("csv.query", staged));
    expect(w.brain.activeRelease(w.org)!.digest).toBe(release.digest);
  });
});
