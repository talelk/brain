import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandReceipt, GitConnection, GitProposal, IntegrationRepository, RepositoryBinding } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { setupWorld, type TestWorld } from "../helpers";
import { createGitRemote } from "../support/git-fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function run(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>, workspace = false): Promise<CommandReceipt> {
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    ...(workspace ? { workspaceId: w.workspaceId } : {}), idempotencyKey: key, payload,
  } as never, key)).receipt;
}

describe("TypeScript Git protocol integrations (T55, E108)", () => {
  it("verifies remote refs, separates repository classes and deduplicates ref-change proposals", async () => {
    const fixture = await createGitRemote();
    cleanup.push(fixture.cleanup);
    const dir = mkdtempSync(join(tmpdir(), "brain-git-protocol-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const connectionId = (await run(w, "integration.connect", "protocol-connect", { provider: "gitea", name: "Protocol remote", repositoryUrl: fixture.remote, username: "git-user", token: "protocol-secret-token" })).resourceId!;
    expect((w.brain.store.control.prepare("SELECT status FROM git_connections WHERE id=?").get(connectionId) as { status: string }).status).toBe("pending");
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    const inventory = ((await w.brain.executeQuery(w.owner, { queryType: "integrations.repositories", resourceId: connectionId })) as { snapshot: { items: IntegrationRepository[] } }).snapshot.items;
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toEqual(expect.objectContaining({ repositoryKey: fixture.remote, defaultBranch: "main", permissions: { read: true, write: true } }));

    const configurationId = (await run(w, "integration.bind", "bind-configuration", { connectionId, workspaceId: w.workspaceId, kind: "configuration", repositoryKey: fixture.remote, access: "write" }, true)).resourceId!;
    const projectId = (await run(w, "integration.bind", "bind-project", { connectionId, workspaceId: w.workspaceId, kind: "project", repositoryKey: fixture.remote, access: "read" }, true)).resourceId!;
    expect(configurationId).not.toBe(projectId);
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    const bindings = ((await w.brain.executeQuery(w.owner, { queryType: "integrations.list" })) as { snapshot: { bindings: RepositoryBinding[] } }).snapshot.bindings;
    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ bindingId: configurationId, kind: "configuration", access: "write", status: "verified" }),
      expect.objectContaining({ bindingId: projectId, kind: "project", access: "read", status: "verified" }),
    ]));
    await expect(Promise.resolve().then(async () => await run(w, "integration.bind", "bind-other-remote", { connectionId, workspaceId: w.workspaceId, kind: "project", repositoryKey: "/tmp/other-repository.git", access: "read" }, true))).rejects.toThrow(/outside the verified connection remote/i);

    await fixture.update("first protocol change\n");
    await run(w, "integration.verify", "verify-first-change", { connectionId });
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    let proposals = ((await w.brain.executeQuery(w.owner, { queryType: "integrations.list" })) as { snapshot: { proposals: GitProposal[] } }).snapshot.proposals;
    expect(proposals).toHaveLength(2);
    expect(proposals.map((proposal) => proposal.bindingId).sort()).toEqual([configurationId, projectId].sort());
    expect(proposals.every((proposal) => proposal.state === "proposed" && (proposal.payload as { ref?: string }).ref === "refs/heads/main")).toBe(true);
    await run(w, "integration.verify", "verify-unchanged", { connectionId });
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    proposals = ((await w.brain.executeQuery(w.owner, { queryType: "integrations.list" })) as { snapshot: { proposals: GitProposal[] } }).snapshot.proposals;
    expect(proposals).toHaveLength(2);

    await fixture.update("second protocol change\n");
    await run(w, "integration.verify", "verify-second-change", { connectionId });
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 1, failed: 0 });
    proposals = ((await w.brain.executeQuery(w.owner, { queryType: "integrations.list" })) as { snapshot: { proposals: GitProposal[] } }).snapshot.proposals;
    expect(proposals).toHaveLength(4);
  });

  it("fails verification for an inaccessible remote without inventing repository state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-git-missing-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const connectionId = (await run(w, "integration.connect", "missing-connect", { provider: "gitea", name: "Missing remote", repositoryUrl: "http://127.0.0.1:9/missing.git" })).resourceId!;
    expect(await w.brain.integrations.verifyPending()).toEqual({ verified: 0, failed: 1 });
    expect((w.brain.store.control.prepare("SELECT status FROM git_connections WHERE id=?").get(connectionId) as { status: string }).status).toBe("failed");
    expect((w.brain.store.control.prepare("SELECT repositories_json FROM git_connections WHERE id=?").get(connectionId) as { repositories_json: string }).repositories_json).toBe("[]");
  });
});

describe("the Git provider is chosen when the integration is set up (spec #90 story 89)", () => {
  async function world() {
    const dir = mkdtempSync(join(tmpdir(), "brain-git-provider-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    return setupWorld(app.brain);
  }
  const attempt = async (w: TestWorld, key: string, payload: Record<string, unknown>) => await Promise.resolve().then(async () => await run(w, "integration.connect", key, payload));

  it("keeps the chosen provider on the connection and shows it in the list", async () => {
    const w = await world();
    for (const [provider, host] of [["github", "https://github.com/acme/app.git"], ["github-enterprise", "https://git.acme.test/acme/app.git"], ["gitlab", "https://gitlab.acme.test/acme/app.git"], ["gitea", "https://gitea.acme.test/acme/app.git"]] as const) {
      await run(w, "integration.connect", `provider-${provider}`, { name: `Remote ${provider}`, provider, repositoryUrl: host });
    }
    const connections = ((await w.brain.executeQuery(w.owner, { queryType: "integrations.list" })) as unknown as { snapshot: { connections: GitConnection[] } }).snapshot.connections;
    expect(connections.map((connection) => [connection.name, connection.provider]).sort()).toEqual([
      ["Remote gitea", "gitea"], ["Remote github", "github"], ["Remote github-enterprise", "github-enterprise"], ["Remote gitlab", "gitlab"],
    ]);
  });

  it("refuses a connection that names no provider or one that is not supported, saying which are", async () => {
    const w = await world();
    const repositoryUrl = "https://git.acme.test/acme/app.git";
    await expect(attempt(w, "no-provider", { name: "No provider", repositoryUrl })).rejects.toThrow(/provider/i);
    for (const provider of ["bitbucket", "azure-devops", "GitHub", ""]) {
      await expect(attempt(w, `bad-${provider || "empty"}`, { name: "Unsupported", provider, repositoryUrl })).rejects.toThrow(/Git provider .* is not supported.*GitHub, GitHub Enterprise, GitLab, Gitea/is);
    }
    expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM git_connections").get()).toEqual({ n: 0 });
  });

  it("does not guess the provider from the address: the chosen one must fit the host it is used with", async () => {
    const w = await world();
    await expect(attempt(w, "github-elsewhere", { name: "Wrong", provider: "github", repositoryUrl: "https://git.acme.test/acme/app.git" })).rejects.toThrow(/GitHub is github\.com.*GitHub Enterprise/is);
    await expect(attempt(w, "ghe-on-github", { name: "Wrong", provider: "github-enterprise", repositoryUrl: "https://github.com/acme/app.git" })).rejects.toThrow(/github\.com is GitHub.*choose GitHub/is);
    // A self-hosted GitLab or Gitea is not recognised by its name: any host works once the owner says what it is.
    await run(w, "integration.connect", "plain-host", { name: "Plain host", provider: "gitlab", repositoryUrl: "https://code.acme.test/acme/app.git" });
  });
});
