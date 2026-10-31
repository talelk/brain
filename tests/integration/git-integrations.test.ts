import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, GitProposal, IntegrationRepository, RepositoryBinding } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { setupWorld, type TestWorld } from "../helpers";
import { createGitRemote } from "../support/git-fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function run(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>, workspace = false): CommandReceipt {
  return w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    ...(workspace ? { workspaceId: w.workspaceId } : {}), idempotencyKey: key, payload,
  } as never, key).receipt;
}

describe("TypeScript Git protocol integrations (T55, E108)", () => {
  it("verifies remote refs, separates repository classes and deduplicates ref-change proposals", async () => {
    const fixture = await createGitRemote();
    cleanup.push(fixture.cleanup);
    const dir = mkdtempSync(join(tmpdir(), "brain-git-protocol-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const connectionId = run(w, "integration.connect", "protocol-connect", { name: "Protocol remote", repositoryUrl: fixture.remote, username: "git-user", token: "protocol-secret-token" }).resourceId!;
    expect((w.brain.store.control.prepare("SELECT status FROM git_connections WHERE id=?").get(connectionId) as { status: string }).status).toBe("pending");
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    const inventory = (w.brain.executeQuery(w.owner, { queryType: "integrations.repositories", resourceId: connectionId }) as { snapshot: { items: IntegrationRepository[] } }).snapshot.items;
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toEqual(expect.objectContaining({ repositoryKey: fixture.remote, defaultBranch: "main", permissions: { read: true, write: true } }));

    const configurationId = run(w, "integration.bind", "bind-configuration", { connectionId, workspaceId: w.workspaceId, kind: "configuration", repositoryKey: fixture.remote, access: "write" }, true).resourceId!;
    const projectId = run(w, "integration.bind", "bind-project", { connectionId, workspaceId: w.workspaceId, kind: "project", repositoryKey: fixture.remote, access: "read" }, true).resourceId!;
    expect(configurationId).not.toBe(projectId);
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    const bindings = (w.brain.executeQuery(w.owner, { queryType: "integrations.list" }) as { snapshot: { bindings: RepositoryBinding[] } }).snapshot.bindings;
    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ bindingId: configurationId, kind: "configuration", access: "write", status: "verified" }),
      expect.objectContaining({ bindingId: projectId, kind: "project", access: "read", status: "verified" }),
    ]));
    expect(() => run(w, "integration.bind", "bind-other-remote", { connectionId, workspaceId: w.workspaceId, kind: "project", repositoryKey: "/tmp/other-repository.git", access: "read" }, true)).toThrow(/outside the verified connection remote/i);

    await fixture.update("first protocol change\n");
    run(w, "integration.verify", "verify-first-change", { connectionId });
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    let proposals = (w.brain.executeQuery(w.owner, { queryType: "integrations.list" }) as { snapshot: { proposals: GitProposal[] } }).snapshot.proposals;
    expect(proposals).toHaveLength(2);
    expect(proposals.map((proposal) => proposal.bindingId).sort()).toEqual([configurationId, projectId].sort());
    expect(proposals.every((proposal) => proposal.state === "proposed" && (proposal.payload as { ref?: string }).ref === "refs/heads/main")).toBe(true);
    run(w, "integration.verify", "verify-unchanged", { connectionId });
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    proposals = (w.brain.executeQuery(w.owner, { queryType: "integrations.list" }) as { snapshot: { proposals: GitProposal[] } }).snapshot.proposals;
    expect(proposals).toHaveLength(2);

    await fixture.update("second protocol change\n");
    run(w, "integration.verify", "verify-second-change", { connectionId });
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    proposals = (w.brain.executeQuery(w.owner, { queryType: "integrations.list" }) as { snapshot: { proposals: GitProposal[] } }).snapshot.proposals;
    expect(proposals).toHaveLength(4);
  });

  it("fails verification for an inaccessible remote without inventing repository state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-git-missing-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const connectionId = run(w, "integration.connect", "missing-connect", { name: "Missing remote", repositoryUrl: "http://127.0.0.1:9/missing.git" }).resourceId!;
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 0, failed: 1 });
    expect((w.brain.store.control.prepare("SELECT status FROM git_connections WHERE id=?").get(connectionId) as { status: string }).status).toBe("failed");
    expect((w.brain.store.control.prepare("SELECT repositories_json FROM git_connections WHERE id=?").get(connectionId) as { repositories_json: string }).repositories_json).toBe("[]");
  });
});
