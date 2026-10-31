import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorContext, CommandReceipt } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { setupWorld, type TestWorld } from "../helpers";
import { createGitRemote } from "../support/git-fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function run(w: TestWorld, commandType: string, key: string, payload: Record<string, unknown>, workspace = false, actor: ActorContext = w.owner): CommandReceipt {
  return w.brain.executeCommand(actor, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType,
    ...(workspace ? { workspaceId: w.workspaceId } : {}), idempotencyKey: key, payload,
  } as never, key).receipt;
}

describe("Git protocol credential and authorization boundaries (T55, E108)", () => {
  it("encrypts optional HTTP credentials at rest and never exposes them in DTOs", async () => {
    const fixture = await createGitRemote();
    cleanup.push(fixture.cleanup);
    const dir = mkdtempSync(join(tmpdir(), "brain-protocol-secret-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const id = run(w, "integration.connect", "secret-connect", { name: "Secret remote", repositoryUrl: fixture.remote, username: "private-user", token: "highly-secret-token" }).resourceId!;
    const stored = w.brain.store.control.prepare("SELECT encrypted_credentials FROM git_connections WHERE id=?").get(id) as { encrypted_credentials: string };
    expect(stored.encrypted_credentials).not.toContain("highly-secret-token");
    expect(stored.encrypted_credentials).not.toContain("private-user");
    await w.brain.integrations.verifyPending();
    expect(JSON.stringify(w.brain.executeQuery(w.owner, { queryType: "integrations.list" }))).not.toContain("highly-secret");
    expect(JSON.stringify(w.brain.executeQuery(w.owner, { queryType: "integrations.repositories", resourceId: id }))).not.toContain("private-user");
  });

  it("requires organization scope and a verified remote before binding", async () => {
    const fixture = await createGitRemote();
    cleanup.push(fixture.cleanup);
    const dir = mkdtempSync(join(tmpdir(), "brain-protocol-scope-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    const id = run(w, "integration.connect", "scope-connect", { name: "Scoped remote", repositoryUrl: fixture.remote }).resourceId!;
    expect(() => run(w, "integration.bind", "bind-before-verify", { connectionId: id, workspaceId: w.workspaceId, kind: "configuration", repositoryKey: fixture.remote, access: "write" }, true)).toThrow(/before binding/i);
    const noScopes = { ...w.owner, scopes: ["workspace:read"] };
    expect(() => run(w, "integration.connect", "no-scope-connect", { name: "Denied", repositoryUrl: fixture.remote }, false, noScopes)).toThrow(/missing scope/i);
    const outsider = { ...w.owner, organizationId: "org-other" };
    expect(() => w.brain.executeQuery(outsider, { queryType: "integrations.repositories", resourceId: id })).toThrow(/not found/i);
  });

  it("rejects embedded remote credentials and unsafe local paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-protocol-url-"));
    const app = await createApp({ dataDir: dir, allowTestActor: true });
    cleanup.push(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    const w = setupWorld(app.brain);
    expect(() => run(w, "integration.connect", "credential-url", { name: "Unsafe", repositoryUrl: "https://user:password@example.test/repo.git" })).toThrow(/cannot contain credentials/i);
    expect(() => run(w, "integration.connect", "unsafe-local", { name: "Unsafe local", repositoryUrl: "/tmp/repo/../secret.git" })).toThrow(/absolute HTTP|requires HTTPS/i);
  });
});
